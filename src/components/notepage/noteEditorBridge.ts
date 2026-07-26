/**
 * The RN → web message router for NoteEditorWebView.
 *
 * The CodeMirror editor inside the WebView posts JSON messages for everything it
 * can't do itself — seeding the document, persisting card bodies, starting AI
 * runs, recording audio, opening links, running shell commands, etc. This module
 * is the single dispatch point for those messages, kept out of the component so
 * the component stays a thin shell of JSX + effects.
 *
 * `handleEditorMessage` is a plain function over an explicit {@link BridgeContext}
 * (the WebView ref, the page's props, the mount-local refs, and the registry
 * sink) rather than a hook, so all of its dependencies are visible at the call
 * site and nothing is captured implicitly.
 */
import type React from 'react';
import { Linking } from 'react-native';
import type { WebViewMessageEvent } from 'react-native-webview';
import { fetchLinkPreview } from '../../utils/linkPreview';
import { getPayloadsForPage, upsertPayload, deletePayload, archivePage } from '../../storage';
import { pairFromPayload, fetchDashboardState, searchNotes } from '../../server/controllers/aiController';
import { fetchProjects } from '../../server/controllers/agentController';
import { fetchViewUrl } from '../../server/controllers/viewController';
import { updateServer, waitForServerBack } from '../../server/controllers/updateController';
import {
  startAsk,
  startNotesChat,
  startClean,
  startIngest,
  startAggTasks,
  startRun,
  startCodeRun,
  codePrompt,
  runStdin,
  runInterrupt,
  stop as stopRun,
  attach as attachRun,
  resume as resumeRun,
  type RunSink,
} from '../../server/runRegistry';
import {
  ensureRecordingPermissions,
  startRecording,
  stopRecording,
  cancelRecording,
  deleteRecordings,
  exportRecording,
  playRecording,
  pausePlayback,
} from '../../server/controllers/audioController';

/** The union of shapes the editor can post over the bridge (loosely typed; each
 *  branch narrows the fields it needs). */
export interface EditorMessage {
  type: string;
  text?: string;
  url?: string;
  id?: string;
  kind?: string;
  question?: string;
  subject?: string;
  context?: { q?: string; a?: string; turns?: { q?: string; a?: string }[] };
  payload?: string;
  pageText?: string;
  guidance?: string;
  label?: string;
  file?: string;
  slug?: string;
  title?: string;
  cmd?: string;
  dir?: string;
  data?: string;
  project?: string;
  port?: number;
  query?: string;
  open?: boolean;
  on?: boolean;
}

type WebViewRef = React.RefObject<{ injectJavaScript: (js: string) => void } | null>;

/** Everything the router needs from the owning component, passed explicitly. */
export interface BridgeContext {
  /** The WebView instance ref; null between unmount and remount (injects no-op). */
  ref: WebViewRef;
  /** Card ids this mount attached to the registry, so unmount can detach exactly those. */
  attachedIds: React.MutableRefObject<Set<string>>;
  /** The /record card id whose clip is currently playing (only one at a time). */
  playingId: React.MutableRefObject<string | null>;
  /** The stable registry render sink for THIS WebView. */
  sink: RunSink;
  initialContent: string;
  readOnly: boolean;
  hasTitle: boolean;
  notebookId: string;
  pageId: string;
  onChangeContent: (content: string) => void;
  onOpenPage?: (slug: string, title: string) => void;
  /** `/archive` finished persisting this page's archived copy — the host then
   *  lifts the page off the pad (and refreshes the dashboard's Archived list). */
  onArchived?: () => void;
  /** A card's full-page overlay (e.g. an expanded /chat, /run, /code, or /view
   *  card) opened or closed, so the host can hide/restore chrome that would
   *  otherwise float on top of the overlay's own footer composer. */
  onWidgetExpandChange?: (expanded: boolean) => void;
  /** A card composer's mic toggle asked to start (`true`) or stop (`false`) the
   *  speech-to-text session. The recognizer is the footer mic's, owned by the
   *  screen — the editor has already put the caret in the box it wants the
   *  transcript to land in. */
  onDictationRequest?: (on: boolean) => void;
  setPairScan: (v: { id: string } | null) => void;
  setProjectDelete: (
    v: { mode: 'confirm'; project: string } | { mode: 'error'; message: string } | null,
  ) => void;
}

/** Route one bridge message to its handler. Unknown types are ignored. */
export function handleEditorMessage(ctx: BridgeContext, e: WebViewMessageEvent): void {
  const {
    ref,
    attachedIds,
    playingId,
    sink,
    initialContent,
    readOnly,
    hasTitle,
    notebookId,
    pageId,
    onChangeContent,
    onOpenPage,
    onArchived,
    onWidgetExpandChange,
    onDictationRequest,
    setPairScan,
    setProjectDelete,
  } = ctx;

  let msg: EditorMessage;
  try {
    msg = JSON.parse(e.nativeEvent.data);
  } catch {
    return;
  }
  // RN → web bridge helper (the editor exposes window.__ai* globals).
  const inject = (js: string) => ref.current?.injectJavaScript(js + ' true;');

  if (msg.type === 'ready') {
    // Once the CM6 editor has mounted: for server-owned pages lock it read-only FIRST
    // (which also enables whole-doc decoration), then seed the document — so the seeding
    // transaction renders the parsed markdown immediately instead of waiting for a tap.
    // Sandbox pages skip the lock and stay editable. After seeding, the editor scans for
    // in-flight AI markers and posts a `reattach` for each (handled below).
    ref.current?.injectJavaScript(
      (readOnly ? 'window.__setReadOnly(true); ' : '') +
        `window.__setDoc(${JSON.stringify(initialContent)});` +
        ' true;',
    );
    // Bundle every externalized card body for this page back into the editor in
    // one batch, right after seeding — so /code transcripts, /run output and
    // /ask answers render without any per-card round trip. Skipped for read-only
    // server pages (their markdown arrives with bodies still inline). The seed
    // above runs the inline→store migration for old notes; this additive merge
    // never clobbers what that just produced.
    if (!readOnly) {
      getPayloadsForPage(pageId)
        .then(payloads => {
          inject(`window.__setPayloads(${JSON.stringify(payloads)});`);
        })
        .catch(() => {});
    }
  } else if (
    msg.type === 'cardPayload' &&
    typeof msg.id === 'string' &&
    typeof msg.kind === 'string' &&
    typeof msg.payload === 'string'
  ) {
    // A card streamed/finished (or an old note migrated): persist its body out
    // of the note markdown, keyed by card id. Fire-and-forget — the editor
    // already holds it in payloadField, this is the durable copy.
    upsertPayload(msg.id, pageId, msg.kind, msg.payload).catch(() => {});
  } else if (msg.type === 'cardDelete' && typeof msg.id === 'string') {
    // A card was deleted (or a /clean review resolved): drop its body row.
    deletePayload(msg.id).catch(() => {});
  } else if (msg.type === 'reattach' && typeof msg.id === 'string') {
    // The editor found an in-flight AI marker after seeding. If the registry
    // still has the live run (same app session, socket kept alive across the
    // swap), adopt it — repaint the buffer and ride the stream. Otherwise the
    // app was restarted: try a durable server-side resume by id, which either
    // reconnects to the still-running laptop session (replaying its tail) or,
    // if it was already reaped, finalizes the card as interrupted via `gone`.
    const id = msg.id;
    if (attachRun(id, sink) === 'none') {
      resumeRun(id, msg.kind ?? 'ask', sink);
    }
    attachedIds.current.add(id);
  } else if (msg.type === 'change' && typeof msg.text === 'string') {
    onChangeContent(msg.text);
  } else if (msg.type === 'cardOverlay' && typeof msg.open === 'boolean') {
    // A card was expanded into (or closed from) its full-page overlay.
    onWidgetExpandChange?.(msg.open);
  } else if (msg.type === 'dictate' && typeof msg.on === 'boolean') {
    // A card composer's mic toggle: start or stop the footer's speech-to-text
    // session. The editor has already focused that widget's box, and the
    // transcript follows the caret, so the words land there.
    onDictationRequest?.(msg.on);
  } else if (msg.type === 'openUrl' && typeof msg.url === 'string') {
    // Open tapped markdown links in the system browser. Restrict schemes so
    // a note can't smuggle in javascript:/file: URLs.
    if (/^(https?|mailto):/i.test(msg.url)) {
      Linking.openURL(msg.url).catch(() => {});
    }
  } else if (msg.type === 'openPage' && typeof msg.title === 'string') {
    // A wikilink tap: flip the pad to the referenced page. `slug` (empty for a
    // bare `[[Title]]`) selects the notebook; `title` selects the page in it.
    onOpenPage?.(msg.slug ?? '', msg.title);
  } else if (msg.type === 'fetchPreview' && typeof msg.url === 'string') {
    // Unfurl a pasted link: fetch its metadata natively (no CORS) and hand
    // the card data back to the WebView to render.
    const url = msg.url;
    if (/^https?:\/\//i.test(url)) {
      fetchLinkPreview(url).then(data => {
        ref.current?.injectJavaScript(
          `window.__setPreview(${JSON.stringify(url)}, ${JSON.stringify(data)}); true;`,
        );
      });
    }
  } else if (msg.type === 'ask' && typeof msg.id === 'string' && typeof msg.question === 'string') {
    // Stream the assistant's answer into the card (registry-owned so it
    // survives page swaps); the final text (or error) commits to the document.
    attachedIds.current.add(msg.id);
    startAsk(msg.id, msg.question, sink, msg.context);
  } else if (
    msg.type === 'notesChat' &&
    typeof msg.id === 'string' &&
    typeof msg.subject === 'string' &&
    typeof msg.question === 'string'
  ) {
    // /talk: like /ask, but the run keeps the orchestrator's ingest_topic tool
    // pointed at msg.subject so the subject's notebook stays current as the
    // conversation goes (registry-owned so it survives page swaps).
    attachedIds.current.add(msg.id);
    startNotesChat(msg.id, msg.subject, msg.question, sink, msg.context);
  } else if (msg.type === 'pair' && typeof msg.id === 'string' && typeof msg.payload === 'string') {
    const id = msg.id;
    pairFromPayload(msg.payload).then(res => {
      inject(
        `window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify({
          status: res.ok ? 'ok' : 'error',
          msg: res.msg,
        })});`,
      );
    });
  } else if (msg.type === 'clean' && typeof msg.id === 'string' && typeof msg.pageText === 'string') {
    // Rewrite the whole page. On success the editor swaps in the cleaned
    // text behind an Accept/Reject bar; on error the notes are left as-is.
    attachedIds.current.add(msg.id);
    startClean(msg.id, msg.pageText, msg.guidance ?? '', !hasTitle, sink);
  } else if (msg.type === 'ingest' && typeof msg.id === 'string' && typeof msg.pageText === 'string') {
    // Sort the whole page into the dashboard's subject servers. On success the
    // page is deleted (via the sink's onIngested); on failure the card shows
    // the error and the page is untouched.
    attachedIds.current.add(msg.id);
    startIngest(msg.id, msg.pageText, sink);
  } else if (msg.type === 'archive' && typeof msg.pageText === 'string') {
    // `/archive`: persist this page's current text (command line already stripped
    // by the editor) together with the archived flag, then tell the host to lift
    // the page off the pad. The write is authoritative — done here rather than
    // through the note list's optimistic content save — so the archived copy is
    // never left holding the `/archive` line. The page id and its card payloads
    // are untouched, so reopening it from the dashboard restores the page intact.
    archivePage(pageId, msg.pageText, Date.now())
      .then(() => onArchived?.())
      .catch(() => {});
  } else if (msg.type === 'aggTasks' && typeof msg.id === 'string' && typeof msg.subject === 'string') {
    // /agg-tasks: sweep one subject's whole notebook for action items and file a
    // task card for each (registry-owned so it survives page swaps). Nothing is
    // deleted either way — the card just updates in place with Claude's summary.
    attachedIds.current.add(msg.id);
    startAggTasks(msg.id, msg.subject, sink);
  } else if (msg.type === 'pairScan' && typeof msg.id === 'string') {
    // Bare `/pair`: open the QR scanner; the scan result feeds pairing.
    setPairScan({ id: msg.id });
  } else if (msg.type === 'recordStart' && typeof msg.id === 'string') {
    // Tap Record: get consent/permissions, then start the background mic
    // capture. On success the card flips to its Stop state with a live timer.
    const id = msg.id;
    const doneRec = (patch: Record<string, unknown>) =>
      inject(`window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify(patch)});`);
    (async () => {
      const denied = await ensureRecordingPermissions();
      if (denied) {
        doneRec({ status: 'error', msg: denied });
        return;
      }
      try {
        const { file, startedAt } = await startRecording(msg.label ?? '', notebookId, pageId);
        doneRec({ status: 'recording', file, startedAt });
      } catch (err) {
        doneRec({ status: 'error', msg: err instanceof Error ? err.message : String(err) });
      }
    })();
  } else if (msg.type === 'recordStop' && typeof msg.id === 'string') {
    // Tap Stop: end capture and commit the clip's duration onto the card.
    const id = msg.id;
    const doneRec = (patch: Record<string, unknown>) =>
      inject(`window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify(patch)});`);
    (async () => {
      try {
        const { file, ms } = await stopRecording();
        doneRec({ status: 'stopped', file, ms });
      } catch (err) {
        doneRec({ status: 'error', msg: err instanceof Error ? err.message : String(err) });
      }
    })();
  } else if (msg.type === 'recordExport' && typeof msg.file === 'string') {
    // Copy the finished clip into the shared Recordings library.
    exportRecording(msg.file).catch(() => {});
  } else if (
    msg.type === 'recordPlay' &&
    typeof msg.id === 'string' &&
    typeof msg.file === 'string'
  ) {
    // Play a finished clip. Only one plays at a time: flip the previously
    // playing card back to Play, then mark this one playing.
    const id = msg.id;
    const setPlay = (cardId: string, playing: boolean) =>
      inject(`window.__recPlay(${JSON.stringify(cardId)}, ${playing});`);
    if (playingId.current && playingId.current !== id) setPlay(playingId.current, false);
    playingId.current = id;
    setPlay(id, true);
    playRecording(msg.file).catch(() => {
      if (playingId.current === id) playingId.current = null;
      setPlay(id, false);
    });
  } else if (msg.type === 'recordPause' && typeof msg.id === 'string') {
    const id = msg.id;
    if (playingId.current === id) playingId.current = null;
    pausePlayback().catch(() => {});
    inject(`window.__recPlay(${JSON.stringify(id)}, false);`);
  } else if (msg.type === 'recordCancel') {
    // × on a card that's actively capturing: stop it and drop its partial file.
    cancelRecording().catch(() => {});
  } else if (msg.type === 'recordDiscard' && typeof msg.file === 'string') {
    // × on a finished card: delete just that clip; never disturbs a recording
    // that may be running on another card.
    deleteRecordings([msg.file]).catch(() => {});
  } else if (msg.type === 'run' && typeof msg.id === 'string' && typeof msg.cmd === 'string') {
    // Stream a shell command from the paired laptop into the terminal card.
    // Registry-owned so it survives page swaps; stdout+stderr merged, ANSI
    // stripped (handled in the registry); the card finalizes on exit/error.
    // `dir` (the project from `/run PROJECT <cmd>`) starts it in that subdir.
    attachedIds.current.add(msg.id);
    startRun(msg.id, msg.cmd, sink, typeof msg.dir === 'string' ? msg.dir : undefined);
  } else if (msg.type === 'runStdin' && typeof msg.id === 'string' && typeof msg.data === 'string') {
    runStdin(msg.id, msg.data);
  } else if (msg.type === 'runSignal' && typeof msg.id === 'string') {
    // Ctrl-C: the process gets SIGINT and exits with its own code (the exit
    // frame still flows, so the card finalizes via the registry's onExit).
    runInterrupt(msg.id);
  } else if (msg.type === 'runStop' && typeof msg.id === 'string') {
    // Stop closes the socket, so no exit frame arrives — tear the session down
    // and finalize the card as "stopped" (negative code) ourselves.
    const id = msg.id;
    stopRun(id);
    attachedIds.current.delete(id);
    inject(`window.__runExit(${JSON.stringify(id)}, -1);`);
  } else if (msg.type === 'code' && typeof msg.id === 'string' && typeof msg.project === 'string') {
    // Open a persistent Claude Code agent session in projects/<name> and
    // stream its transcript into the /code card (registry-owned so it survives
    // page swaps). Parsed stream events map to compact {t,...} blocks.
    attachedIds.current.add(msg.id);
    startCodeRun(msg.id, msg.project, sink);
  } else if (msg.type === 'codePrompt' && typeof msg.id === 'string' && typeof msg.text === 'string') {
    // Feed a follow-up turn to the running session; the registry echoes it into
    // the transcript (and buffers it, so a re-attach still shows the prompt).
    codePrompt(msg.id, msg.text);
  } else if (msg.type === 'listProjects') {
    // The editor is autocompleting `/code <name>`: fetch the current project
    // dirs off the paired laptop and push them back so the menu can offer
    // them. Fire-and-forget from the editor's side — an empty list (nothing
    // paired / server down) just yields no suggestions.
    fetchProjects().then(names => {
      inject(`window.__setProjects(${JSON.stringify(names)});`);
    });
  } else if (msg.type === 'listSubjects') {
    // The editor is autocompleting `/talk <subject>`: fetch the orchestrator's
    // existing notebook slugs off the paired laptop and push them back so the
    // menu can offer them. Fire-and-forget — an empty list (nothing paired,
    // server started without -root, or no notebooks yet) just yields no
    // suggestions; typing a fresh subject still works to start a new one.
    fetchDashboardState()
      .then(state => state.servers.map(s => s.name))
      .catch(() => [])
      .then(names => {
        inject(`window.__setTalkSubjects(${JSON.stringify(names)});`);
      });
  } else if (msg.type === 'search' && typeof msg.query === 'string') {
    // The editor is autocompleting `/search <query>`: run it against the paired
    // laptop's notebook pages and push matches back so the menu can offer them.
    // The query rides along in the reply so a round trip that lands after the
    // user has kept typing can be told apart from the current one (see
    // window.__setSearchResults, which drops a stale reply instead of showing
    // it). Fire-and-forget — an empty list (nothing paired, server started
    // without -root, or no matches) just yields no suggestions.
    const query = msg.query;
    searchNotes(query).then(results => {
      inject(`window.__setSearchResults(${JSON.stringify(query)}, ${JSON.stringify(results)});`);
    });
  } else if (msg.type === 'deleteProject' && typeof msg.project === 'string') {
    // The editor cleared its `/delete PROJECT` line and asked us to remove
    // the folder. This is destructive, so raise the same ConfirmDialog the
    // page-delete flow uses; the folder is only removed once the user taps
    // Delete (see the projectDelete dialog in the component's render).
    setProjectDelete({ mode: 'confirm', project: msg.project });
  } else if (msg.type === 'codeStop' && typeof msg.id === 'string') {
    // Stop kills the session and closes the socket; finalize the card here
    // since no clean exit frame will arrive.
    const id = msg.id;
    stopRun(id);
    attachedIds.current.delete(id);
    inject(`window.__codeExit(${JSON.stringify(id)});`);
  } else if (msg.type === 'view' && typeof msg.id === 'string' && typeof msg.port === 'number') {
    // Build the plaintext preview URL for a localhost dev server on the paired
    // laptop and hand it to the card's iframe; on failure the card shows the
    // reason instead. Transient (token-bearing) URL — never persisted to the
    // note, refetched by the editor on every mount (see viewFetcher).
    const id = msg.id;
    fetchViewUrl(msg.port).then(res => {
      if (res.url) {
        inject(`window.__viewUrl(${JSON.stringify(id)}, ${JSON.stringify(res.url)});`);
      } else {
        inject(
          `window.__viewError(${JSON.stringify(id)}, ${JSON.stringify(
            res.error ?? 'Could not load the page.',
          )});`,
        );
      }
    });
  } else if (msg.type === 'updateServer' && typeof msg.id === 'string') {
    // Tell the paired laptop to pull, rebuild its Go server, and restart. The
    // card shows the build output and tracks the phases: running → (on success)
    // "restarting…" while the server relaunches, then "reconnected" once its
    // liveness probe answers again; on failure it shows which step broke.
    const id = msg.id;
    const done = (patch: { status: string; msg: string; out?: string }) =>
      inject(`window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify(patch)});`);
    updateServer().then(res => {
      if (res.error) {
        done({ status: 'error', msg: res.error });
        return;
      }
      if (!res.ok) {
        const label =
          res.phase === 'pull'
            ? 'git pull failed'
            : res.phase === 'build'
              ? 'Rebuild failed'
              : 'Update failed';
        done({ status: 'error', msg: label, out: res.out });
        return;
      }
      // Rebuilt; the server is relaunching into the new binary. Keep the card
      // in-flight (status 'running' preserves its id) until the probe answers.
      done({ status: 'running', msg: 'Rebuilt — restarting server…', out: res.out });
      waitForServerBack().then(back => {
        done({
          status: back ? 'ok' : 'error',
          msg: back
            ? 'Server updated & reconnected'
            : 'Rebuilt, but the server didn’t come back — check the laptop',
          out: res.out,
        });
      });
    });
  }
}
