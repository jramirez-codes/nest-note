import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import {
  WebView as RNWebView,
  type WebViewMessageEvent,
  type WebViewProps,
} from 'react-native-webview';
import { EDITOR_HTML } from '../../webview/editorHtml';
import { pairFromPayload } from '../../server/controllers/aiController';
import { removeProject } from '../../server/controllers/agentController';
import { detach as detachRun, type RunSink } from '../../server/runRegistry';
import { stopPlayback, onPlaybackEnded } from '../../server/controllers/audioController';
import ConfirmDialog from '../modals/ConfirmDialog';
import QrPairModal from '../modals/QrPairModal';
import { handleEditorMessage } from './noteEditorBridge';

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
   * A card's full-page overlay (an expanded /chat, /run, /code, or /view card)
   * opened or closed. The overlay fills the whole WebView with its own footer
   * composer, so the host should hide any chrome it floats on top of the
   * WebView while this is true, and restore it once it flips back to false.
   */
  onWidgetExpandChange?: (expanded: boolean) => void;
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
  onWidgetExpandChange,
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
  // Drives the `/delete PROJECT` flow's dialog: a `confirm` step asking before
  // the destructive delete, then an `error` notice if the server call fails.
  // Both render through ConfirmDialog, matching the page-delete confirmation.
  const [projectDelete, setProjectDelete] = useState<
    { mode: 'confirm'; project: string } | { mode: 'error'; message: string } | null
  >(null);

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
    (e: WebViewMessageEvent) =>
      handleEditorMessage(
        {
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
          onWidgetExpandChange,
          setPairScan,
          setProjectDelete,
        },
        e,
      ),
    [
      initialContent,
      hasTitle,
      onChangeContent,
      onOpenPage,
      onWidgetExpandChange,
      readOnly,
      notebookId,
      pageId,
      sink,
    ],
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

  // If this page unmounts (swiped away) while a card overlay is open, restore
  // the bubble footer the overlay had asked the host to hide — the overlay's
  // own WebView state is gone with it, so no `cardOverlay` close message will
  // ever arrive.
  useEffect(() => () => onWidgetExpandChange?.(false), [onWidgetExpandChange]);

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
      {projectDelete?.mode === 'confirm' && (
        <ConfirmDialog
          visible
          title="Delete project"
          message={`Are you sure you want to delete the project “${projectDelete.project}”? This removes its folder on the paired laptop and cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          onConfirm={() => {
            const project = projectDelete.project;
            setProjectDelete(null);
            removeProject(project).then(res => {
              if (!res.ok) {
                setProjectDelete({
                  mode: 'error',
                  message: res.error ?? 'Something went wrong deleting the project.',
                });
              }
            });
          }}
          onCancel={() => setProjectDelete(null)}
        />
      )}
      {projectDelete?.mode === 'error' && (
        <ConfirmDialog
          visible
          title="Could not delete project"
          message={projectDelete.message}
          confirmLabel="OK"
          hideCancel
          onConfirm={() => setProjectDelete(null)}
          onCancel={() => setProjectDelete(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#1e1e2e' },
});
