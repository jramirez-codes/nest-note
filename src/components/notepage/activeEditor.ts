/**
 * A module-level handle on the *active* note editor's WebView injector.
 *
 * The speech-to-text mic lives in the footer (PageIndicator), outside every
 * WebView, but its transcribed text has to land in whichever note is on screen.
 * Rather than thread a WebView ref up through PaperPager's virtualization to the
 * footer, each NoteEditorWebView registers its injector here while it's the
 * active, editable page and clears it when swiped away, made read-only, or
 * unmounted. The dictation hook then reaches the current editor through
 * {@link injectIntoActiveEditor} without knowing which page that is.
 *
 * Only one page is active at a time, so this is a single slot, not a map — and
 * read-only subject pages never register, so dictation into them no-ops rather
 * than silently mutating an immutable page.
 *
 * Not every dictation target is a WebView, though: an idea page's chat composer
 * is a plain React Native TextInput sitting in a Modal over the whole pad. Such a
 * target registers a {@link DictationSink} instead, which takes precedence over
 * the editor slot for as long as it's mounted — it's on top of the pad, so the
 * page underneath must not receive the words (or be armed into dictation mode).
 */
type Injector = (js: string) => void;

/**
 * A non-WebView dictation target. It receives the same session semantics the
 * editor's `window.__dictate*` hooks implement: each partial `text` REPLACES the
 * utterance in progress, an `isFinal` one commits it, and `endUtterance` freezes
 * whatever landed when a session ends without a final (a no-match).
 */
export interface DictationSink {
  text(chunk: string, isFinal: boolean): void;
  endUtterance(): void;
  backspace(): void;
  /** One Enter press — for a composer box, that submits it. */
  newline(): void;
}

let active: Injector | null = null;
let sink: DictationSink | null = null;

// Whether a dictation session is currently live. Held here (not just in the hook)
// so that when the user swipes to a different note mid-session, the incoming
// editor can be re-armed into the keyboard-suppressed dictation mode on register.
let dictationLive = false;

/**
 * Mark `inject` as the active editor's channel. Returns an unregister function
 * that only clears the slot if it still points at this same injector, so a late
 * cleanup from an outgoing page can't wipe the incoming page's registration
 * (mount order during a swap isn't guaranteed).
 */
export function registerActiveEditor(inject: Injector): () => void {
  active = inject;
  // A swap mid-dictation: arm the newly-active editor so its caret shows and the
  // keyboard stays suppressed, matching the page the user just left.
  if (dictationLive) injectIntoActiveEditor('window.__dictateActive(true);');
  return () => {
    if (active === inject) active = null;
  };
}

/**
 * Mark `s` as the dictation target, ahead of any editor. Returns an unregister
 * that only clears the slot if it still points at this same sink, mirroring
 * {@link registerActiveEditor}.
 */
export function registerDictationSink(s: DictationSink): () => void {
  sink = s;
  return () => {
    if (sink === s) sink = null;
  };
}

/**
 * Toggle dictation mode on the active editor (focus + soft-keyboard suppression),
 * and remember it so page swaps re-arm the incoming editor. Driven by useDictation
 * at the start/end of a session. A registered sink owns the session instead, and
 * the editor underneath is deliberately left alone.
 */
export function setDictationLive(on: boolean): void {
  dictationLive = on;
  if (sink) return;
  injectIntoActiveEditor(`window.__dictateActive(${on ? 'true' : 'false'});`);
}

/**
 * Deliver a chunk of transcript to the current target: a partial replaces the
 * utterance in progress, a final one commits it.
 */
export function dictateChunk(text: string, isFinal: boolean): void {
  if (sink) {
    sink.text(text, isFinal);
    return;
  }
  injectIntoActiveEditor(`window.__dictate(${JSON.stringify(text)}, ${isFinal ? 'true' : 'false'});`);
}

/**
 * Close the utterance in progress before the recognizer re-listens, freezing any
 * partial text a session left behind with no final to replace it.
 */
export function endDictationUtterance(): void {
  if (sink) {
    sink.endUtterance();
    return;
  }
  injectIntoActiveEditor('window.__dictateEnd();');
}

/**
 * Emulate a single Backspace press in the active editor — the footer's
 * recording-mode Delete button, which replaces a nav bubble while the mic is live
 * so a misheard character can be dropped without pausing dictation.
 */
export function backspaceActiveEditor(): void {
  if (sink) {
    sink.backspace();
    return;
  }
  injectIntoActiveEditor('window.__dictateBackspace();');
}

/**
 * Emulate a single Enter press in the active editor — the footer's recording-mode
 * New line button. Goes through the editor's normal Enter handling, so on a slash
 * command line it fires the command and inside a card composer it submits the box.
 */
export function newlineActiveEditor(): void {
  if (sink) {
    sink.newline();
    return;
  }
  injectIntoActiveEditor('window.__dictateNewline();');
}

/** Whether anything is on screen to receive dictation right now. */
export function hasActiveEditor(): boolean {
  return active !== null || sink !== null;
}

/** Inject JS into the active editor's WebView; a no-op when none is active. */
export function injectIntoActiveEditor(js: string): void {
  active?.(js + ' true;');
}
