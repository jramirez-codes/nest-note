// Every inline SVG glyph the editor draws, in one place. All are stroked/filled
// with `currentColor`, so a button's colour classes (green when copied, red in
// delete mode, teal/mauve accents) tint them for free. Offline-safe (no icon
// font, no network) — the whole editor ships as one self-contained HTML string.

// Shared opener for the stroked, rounded line-icons (copy, trash, send, …).
const STROKE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">';

// Copy / delete affordances (code, link, image and card action buttons).
export const COPY =
  STROKE +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
export const CHECK = STROKE + '<polyline points="20 6 9 17 4 12"/></svg>';
export const TRASH =
  STROKE +
  '<polyline points="3 6 5 6 21 6"/>' +
  '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
  '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

// Paper-plane "send" for the follow-up / stdin / prompt composers.
export const SEND =
  STROKE +
  '<line x1="22" y1="2" x2="11" y2="13"/>' +
  '<polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

// Run-card controls: slash-circle for the graceful ⌃C interrupt (SIGINT); the
// shared filled square (STOP) is the hard Stop / kill.
export const INTERRUPT =
  STROKE +
  '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';

// Share/export arrow (finished /record clip) and maximize-to-corners (expand a
// /run or /code card into its full-page view).
export const EXPORT =
  STROKE +
  '<path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/></svg>';
export const EXPAND =
  STROKE +
  '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>' +
  '<line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

// Back chevron for the full-page overlay header.
export const BACK = STROKE + '<polyline points="15 18 9 12 15 6"/></svg>';

// Chat-bubble glyph for the /talk card's subject pill (mirrors /code's project chip).
export const CHAT =
  STROKE +
  '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 ' +
  '8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

// File-tool glyphs for the /code transcript's editor panes: a plain document
// (Write/new file), a document with a pencil (Edit), and an eye (Read/view).
const FILE_BODY =
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
  '<polyline points="14 2 14 8 20 8"/>';
export const FILE = STROKE + FILE_BODY + '</svg>';
export const FILE_EDIT =
  STROKE +
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6"/>' +
  '<polyline points="14 2 14 8 20 8"/>' +
  '<path d="M21.5 13.5 16 19l-2.5.5.5-2.5 5.5-5.5a1.4 1.4 0 0 1 2 2z"/></svg>';
export const EYE =
  STROKE +
  '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>' +
  '<circle cx="12" cy="12" r="3"/></svg>';

// Filled glyphs (mic / stop / play / pause) — the /record card's whole UI is the
// mic↔stop and play↔pause swaps on a single round button.
export const MIC =
  '<svg viewBox="0 0 24 24" fill="currentColor">' +
  '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'd="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
export const STOP =
  '<svg viewBox="0 0 24 24" fill="currentColor">' +
  '<rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
export const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
export const PAUSE =
  '<svg viewBox="0 0 24 24" fill="currentColor">' +
  '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
