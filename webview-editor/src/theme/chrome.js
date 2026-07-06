import { c } from './palette.js';

// Chrome for the main note editor (padding, caret, selection, background).
export const chrome = {
  '&': { color: c.text, backgroundColor: c.base, fontSize: '17px' },
  '.cm-content': {
    fontFamily: '-apple-system, Roboto, sans-serif',
    lineHeight: '1.5',
    padding: '8px 24px 120px',
    caretColor: c.mauve,
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.mauve },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: c.surface0,
  },
  '.cm-scroller': { overflow: 'auto' },
  '&.cm-focused': { outline: 'none' },
};

// Chrome for the read-only markdown views mounted inside /ask cards: transparent
// and compact, auto-height (grows to content), no caret — it's LLM output, not
// an editable surface.
export const answerChrome = {
  '&': { backgroundColor: 'transparent', color: c.subtext0, fontSize: '14px', height: 'auto' },
  // IMPORTANT: the nested answer editor lives inside the MAIN editor's DOM, so
  // the main theme's descendant rules (e.g. `.cm-content{padding:8px 24px 120px}`
  // — a 120px bottom strip and 24px sides) leak in with equal specificity. Force
  // the answer's own layout to win.
  '.cm-content': {
    fontFamily: '-apple-system, Roboto, sans-serif',
    lineHeight: '1.5',
    padding: '10px 0 0 0 !important',
    caretColor: 'transparent',
    minHeight: '0 !important',
  },
  '.cm-cursor, .cm-dropCursor': { display: 'none' },
  // Shrink the scroller to content instead of filling 100% of the editor.
  '.cm-scroller': { overflow: 'visible !important', height: 'auto !important' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0 !important' },
  // Code blocks: the card itself is `mantle`, so give code a darker background
  // for contrast, and wrap long tokens (the card clips overflow). The doubled
  // class outranks both the shared and the leaked main-editor `.cm-code-line`.
  // The `.cm-line{padding:0 !important}` rule above (needed to flatten the
  // answer's own lines) also strips the code card's own inset and its
  // first/last-line toolbar padding, so restore them here with `!important`:
  // without the horizontal inset the code hugs the left edge, and without the
  // first line's vertical padding the centred copy button pokes out the top.
  '.cm-code-line.cm-code-line': {
    backgroundColor: c.crust,
    overflowWrap: 'anywhere',
    paddingLeft: '16px !important',
    paddingRight: '16px !important',
  },
  '.cm-code-first.cm-code-first': {
    paddingTop: '0.7em !important',
    paddingBottom: '0.7em !important',
  },
  '.cm-code-last.cm-code-last': {
    paddingBottom: '0.7em !important',
  },
  // Same story as the code card above: `.cm-line{padding:0 !important}` also
  // flattens blockquote lines (`.cm-blockquote` is a line decoration on the same
  // element), collapsing the text against the accent bar. Restore the quote's
  // own inset + rounded-end padding with doubled-class `!important`.
  '.cm-blockquote.cm-blockquote': {
    paddingLeft: '16px !important',
  },
  '.cm-blockquote-first.cm-blockquote-first': {
    paddingTop: '3px !important',
  },
  '.cm-blockquote-last.cm-blockquote-last': {
    paddingBottom: '3px !important',
  },
};
