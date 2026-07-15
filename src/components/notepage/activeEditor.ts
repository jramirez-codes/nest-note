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
 */
type Injector = (js: string) => void;

let active: Injector | null = null;

/**
 * Mark `inject` as the active editor's channel. Returns an unregister function
 * that only clears the slot if it still points at this same injector, so a late
 * cleanup from an outgoing page can't wipe the incoming page's registration
 * (mount order during a swap isn't guaranteed).
 */
export function registerActiveEditor(inject: Injector): () => void {
  active = inject;
  return () => {
    if (active === inject) active = null;
  };
}

/** Whether an editable note is on screen to receive dictation right now. */
export function hasActiveEditor(): boolean {
  return active !== null;
}

/** Inject JS into the active editor's WebView; a no-op when none is active. */
export function injectIntoActiveEditor(js: string): void {
  active?.(js + ' true;');
}
