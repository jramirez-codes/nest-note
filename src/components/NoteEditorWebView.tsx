import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Linking, StyleSheet, View } from 'react-native';
import { fetchLinkPreview } from '../utils/linkPreview';
import {
  WebView as RNWebView,
  type WebViewMessageEvent,
  type WebViewProps,
} from 'react-native-webview';
import { EDITOR_HTML } from '../webview/editorHtml';
import { pairFromPayload } from '../server/aiController';
import { fetchProjects } from '../server/agentController';
import { fetchViewUrl } from '../server/viewController';
import {
  startAsk,
  startClean,
  startIngest,
  startRun,
  startCodeRun,
  codePrompt,
  runStdin,
  runInterrupt,
  stop as stopRun,
  attach as attachRun,
  detach as detachRun,
  resume as resumeRun,
  type RunSink,
} from '../server/runRegistry';
import {
  ensureRecordingPermissions,
  startRecording,
  stopRecording,
  cancelRecording,
  deleteRecordings,
  exportRecording,
  playRecording,
  pausePlayback,
  stopPlayback,
  onPlaybackEnded,
} from '../server/audioController';
import QrPairModal from './QrPairModal';

// react-native-webview@14's class-component typings resolve to `never` under
// React 19's JSX types (RN 0.86), so re-type it as a normal component. Runtime
// is unaffected — this is purely to restore prop/ref type-checking.
type WebViewInstance = InstanceType<typeof RNWebView>;
const WebView = RNWebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<WebViewInstance>
>;

interface NoteEditorWebViewProps {
  /** Initial editor content — markdown, same as the rest of the app. */
  initialContent: string;
  /** False once the page is swiped away from, so we drop keyboard focus. */
  isActive: boolean;
  /** Whether the page already has a title; when false, `/clean` generates one. */
  hasTitle: boolean;
  onChangeContent: (content: string) => void;
  /** Store an AI-generated title produced by `/clean` (called at most once). */
  onSetTitle: (title: string) => void;
  /** Called when `/ingest` finishes filing this page — the page is then deleted. */
  onIngested: () => void;
  /**
   * A wikilink (`[[slug::Title]]` / bare `[[Title]]`) was tapped: flip the pad to that page.
   * `slug` selects a subject notebook (empty = the current one); `title` picks the page.
   */
  onOpenPage?: (slug: string, title: string) => void;
  /**
   * Render the content read-only: no caret, no typing, no edits (CM6 editable off +
   * EditorState.readOnly). Used for subject-notebook pages pulled from the server, which
   * are viewable but not editable on the phone — only the local Sandbox is edited.
   */
  readOnly?: boolean;
  /**
   * Notebook + page this editor belongs to. /record clips are cached and then
   * migrated into this notebook's per-page media bucket, so recording needs both.
   */
  notebookId: string;
  pageId: string;
}

/**
 * Markdown editor backed by CodeMirror 6 running inside a WebView — the path
 * toward Obsidian-style live preview, custom widgets, and toggleable section
 * decorations, all of which are CM6 features with no native-RN equivalent.
 *
 * Content is markdown in and markdown out (CM6 edits the source text), so notes
 * stay in the app's markdown storage format with no data migration.
 *
 * AI runs (/ask, /clean, /ingest, /run, /code) are NOT owned here — they live in
 * the app-level runRegistry so they survive this component being unmounted when
 * the page is swiped away. This component only attaches its WebView as a render
 * sink while mounted and detaches (without cancelling) on unmount; a re-mount
 * re-attaches by card id and repaints from the registry's buffer.
 */
export default function NoteEditorWebView({
  initialContent,
  isActive,
  hasTitle,
  onChangeContent,
  onSetTitle,
  onIngested,
  onOpenPage,
  readOnly = false,
  notebookId,
  pageId,
}: NoteEditorWebViewProps) {
  const ref = useRef<WebViewInstance>(null);
  // Card ids this mount is currently attached to in the registry, so we can
  // detach exactly those (and no more) when the page unmounts.
  const attachedIds = useRef<Set<string>>(new Set());
  // The /record card id whose clip is currently playing (only one at a time), so
  // starting another or a natural end can flip the right card's button back.
  const playingId = useRef<string | null>(null);
  // Set when a bare `/pair` asks to scan a QR; carries the card id to update.
  const [pairScan, setPairScan] = useState<{ id: string } | null>(null);

  // Page-coupled callbacks the registry may fire long after this render (a run
  // that finishes while detached, then re-attaches). Held in a ref so the stable
  // sink below always calls the latest props.
  const cbRef = useRef({ onSetTitle, onIngested, hasTitle });
  cbRef.current = { onSetTitle, onIngested, hasTitle };

  // A stable render sink for the registry: how to inject into THIS WebView plus
  // the two side effects that don't go through it. Created once; `inject` reads
  // `ref.current` at call time (null after unmount → a harmless no-op), and the
  // side effects read the latest props via cbRef.
  const sink = useRef<RunSink>({
    inject: (js: string) => ref.current?.injectJavaScript(js + ' true;'),
    onSetTitle: (t: string) => cbRef.current.onSetTitle(t),
    onIngested: () => cbRef.current.onIngested(),
  }).current;

  const handleMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: {
        type: string;
        text?: string;
        url?: string;
        id?: string;
        kind?: string;
        question?: string;
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
      };
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
              `window.__setPreview(${JSON.stringify(url)}, ${JSON.stringify(
                data,
              )}); true;`,
            );
          });
        }
      } else if (
        msg.type === 'ask' &&
        typeof msg.id === 'string' &&
        typeof msg.question === 'string'
      ) {
        // Stream the assistant's answer into the card (registry-owned so it
        // survives page swaps); the final text (or error) commits to the document.
        attachedIds.current.add(msg.id);
        startAsk(msg.id, msg.question, sink, msg.context);
      } else if (
        msg.type === 'pair' &&
        typeof msg.id === 'string' &&
        typeof msg.payload === 'string'
      ) {
        const id = msg.id;
        pairFromPayload(msg.payload).then(res => {
          inject(
            `window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify({
              status: res.ok ? 'ok' : 'error',
              msg: res.msg,
            })});`,
          );
        });
      } else if (
        msg.type === 'clean' &&
        typeof msg.id === 'string' &&
        typeof msg.pageText === 'string'
      ) {
        // Rewrite the whole page. On success the editor swaps in the cleaned
        // text behind an Accept/Reject bar; on error the notes are left as-is.
        attachedIds.current.add(msg.id);
        startClean(msg.id, msg.pageText, msg.guidance ?? '', !hasTitle, sink);
      } else if (
        msg.type === 'ingest' &&
        typeof msg.id === 'string' &&
        typeof msg.pageText === 'string'
      ) {
        // Sort the whole page into the dashboard's subject servers. On success the
        // page is deleted (via the sink's onIngested); on failure the card shows
        // the error and the page is untouched.
        attachedIds.current.add(msg.id);
        startIngest(msg.id, msg.pageText, sink);
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
            const { file, startedAt } = await startRecording(
              msg.label ?? '',
              notebookId,
              pageId,
            );
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
      } else if (
        msg.type === 'runStdin' &&
        typeof msg.id === 'string' &&
        typeof msg.data === 'string'
      ) {
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
      } else if (
        msg.type === 'codePrompt' &&
        typeof msg.id === 'string' &&
        typeof msg.text === 'string'
      ) {
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
      }
    },
    [initialContent, hasTitle, onChangeContent, onOpenPage, readOnly, notebookId, pageId, sink],
  );

  // Feed a resolved pairing outcome back into the /pair card, then close scanner.
  const finishPairScan = useCallback(
    (id: string, status: 'ok' | 'error', message: string) => {
      setPairScan(null);
      ref.current?.injectJavaScript(
        `window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify({
          status,
          msg: message,
        })}); true;`,
      );
    },
    [],
  );

  // On unmount, DETACH this WebView from every run it was rendering — the runs
  // keep going in the registry (and keep buffering), so swiping back re-adopts
  // them mid-stream. This is the crux of "swapping pages doesn't kill the output":
  // we deliberately do NOT cancel here (that's only for an explicit Stop/×).
  useEffect(() => {
    const ids = attachedIds.current;
    return () => {
      for (const id of ids) detachRun(id, sink);
    };
  }, [sink]);

  // When a clip finishes on its own, flip its card's button back to Play. Also
  // stop playback when the editor goes away, so audio doesn't outlive the view.
  useEffect(() => {
    const sub = onPlaybackEnded(() => {
      const id = playingId.current;
      if (!id) return;
      playingId.current = null;
      ref.current?.injectJavaScript(`window.__recPlay(${JSON.stringify(id)}, false); true;`);
    });
    return () => {
      sub.remove();
      if (playingId.current) playingId.current = null;
      stopPlayback().catch(() => {});
    };
  }, []);

  // Drop focus (and dismiss the keyboard) when swiped away from.
  useEffect(() => {
    if (!isActive) {
      ref.current?.injectJavaScript('document.activeElement?.blur(); true;');
    }
  }, [isActive]);

  // Keep the editor's DOM focus in sync with the keyboard. When the user hides
  // the keyboard (system Back button, swipe-down) without leaving the note, the
  // WebView's contenteditable keeps focus — so on Android a later tap won't
  // re-raise the keyboard (no focus change fires) and typing feels dead. Blur
  // the editor whenever the keyboard hides so the next tap reliably re-focuses
  // the note and brings the keyboard back. CM6 keeps the caret in editor state
  // across blur, so the cursor position is preserved on re-focus.
  useEffect(() => {
    if (!isActive) return;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      ref.current?.injectJavaScript('document.activeElement?.blur(); true;');
    });
    return () => sub.remove();
  }, [isActive]);

  return (
    <View style={styles.fill}>
      <WebView
        ref={ref}
        source={{ html: EDITOR_HTML }}
        originWhitelist={['*']}
        onMessage={handleMessage}
        // A /view card embeds a localhost dev server from the paired laptop over
        // plaintext HTTP (the LAN preview proxy); allow that mixed content so the
        // iframe can load. Everything else the editor loads is inline/self-hosted.
        mixedContentMode="always"
        // Let a tap raise the keyboard directly, and drop the iOS input bar.
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        // CM6 owns scrolling; the WebView itself shouldn't bounce/scroll.
        scrollEnabled={false}
        automaticallyAdjustContentInsets={false}
        style={styles.fill}
      />
      {pairScan && (
        <QrPairModal
          visible
          onScanned={payload => {
            const id = pairScan.id;
            setPairScan(null);
            pairFromPayload(payload).then(res =>
              finishPairScan(id, res.ok ? 'ok' : 'error', res.msg),
            );
          }}
          onClose={() => finishPairScan(pairScan.id, 'error', 'Pairing cancelled')}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#1e1e2e' },
});
