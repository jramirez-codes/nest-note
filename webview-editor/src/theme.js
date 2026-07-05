import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Catppuccin Mocha, matched to the app theme.
const c = {
  crust: '#11111b',
  mantle: '#181825',
  base: '#1e1e2e',
  surface0: '#313244',
  surface1: '#45475a',
  overlay1: '#7f849c',
  subtext0: '#a6adc8',
  text: '#cdd6f4',
  mauve: '#cba6f7',
  blue: '#89b4fa',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  peach: '#fab387',
  teal: '#94e2d5',
  red: '#f38ba8',
};

// Chrome for the main note editor (padding, caret, selection, background).
const chrome = {
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
const answerChrome = {
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

// Component styles (class-based, view-agnostic) — shared by both chromes so the
// nested answer views render code cards, blockquotes, links etc. identically.
const components = {
    // --- Task-list checkbox -------------------------------------------------
    '.cm-task': {
      display: 'inline-block',
      width: '1.05em',
      height: '1.05em',
      verticalAlign: '-0.18em',
      marginRight: '0.3em',
      borderRadius: '5px',
      border: `2px solid ${c.overlay1}`,
      boxSizing: 'border-box',
      cursor: 'pointer',
      position: 'relative',
    },
    '.cm-task.cm-task-done': {
      backgroundColor: c.green,
      borderColor: c.green,
    },
    // The check mark, drawn with a rotated border so no font/icon is needed.
    '.cm-task.cm-task-done::after': {
      content: '""',
      position: 'absolute',
      left: '0.28em',
      top: '0.06em',
      width: '0.22em',
      height: '0.5em',
      border: `solid ${c.crust}`,
      borderWidth: '0 0.14em 0.14em 0',
      transform: 'rotate(43deg)',
    },

    // A completed task line: strike through all its text. The checkbox itself is
    // an inline-block box, so line-through doesn't cross it — only the text.
    '.cm-task-done-line': {
      textDecoration: 'line-through',
      textDecorationColor: c.overlay1,
      color: c.subtext0,
    },

    // --- Unordered-list bullet ----------------------------------------------
    '.cm-bullet': {
      color: c.text,
      // A slightly larger dot than the raw "-", nudged to sit on the baseline.
      fontSize: '1.1em',
      lineHeight: '1',
    },

    // --- Fenced code card ---------------------------------------------------
    '.cm-code-line': {
      backgroundColor: c.mantle,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '14px',
      padding: '0 16px',
    },
    '.cm-code-first': {
      position: 'relative',
      // Symmetric padding turns the fence line into a toolbar row: with equal
      // top/bottom the line's vertical centre matches the box centre, so the
      // copy button (centred below) lines up with the ``` text.
      paddingTop: '0.7em',
      paddingBottom: '0.7em',
      borderTopLeftRadius: '10px',
      borderTopRightRadius: '10px',
      borderTop: `1px solid ${c.surface0}`,
    },
    // The code card's copy button is centred on the fence line (the link card's
    // stays pinned to its top-right corner via the base rule above).
    '.cm-code-first .cm-copy-btn': {
      top: '50%',
      transform: 'translateY(-50%)',
    },
    '.cm-code-last': {
      paddingBottom: '0.7em',
      borderBottomLeftRadius: '10px',
      borderBottomRightRadius: '10px',
      borderBottom: `1px solid ${c.surface0}`,
    },
    '.cm-copy-btn': {
      position: 'absolute',
      top: '0.55em',
      right: '0.7em',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '6px',
      color: c.subtext0,
      backgroundColor: c.surface0,
      border: `1px solid ${c.surface1}`,
      borderRadius: '7px',
      cursor: 'pointer',
      userSelect: 'none',
      zIndex: '2',
    },
    '.cm-copy-btn svg': {
      display: 'block',
      width: '16px',
      height: '16px',
    },
    '.cm-copy-btn.cm-copied': {
      color: c.green,
      borderColor: c.green,
    },
    // Delete mode (after a long-press on the card).
    '.cm-copy-btn.cm-del-btn': {
      color: c.red,
      borderColor: c.red,
    },
    // Header variant: sits inline in the flex header instead of pinned absolute.
    '.cm-copy-btn.cm-copy-inline': {
      position: 'static',
      flexShrink: '0',
      alignSelf: 'center',
    },

    // --- Links --------------------------------------------------------------
    '.cm-link': {
      color: c.blue,
      textDecoration: 'underline',
      cursor: 'pointer',
    },
    // Link text inside a blockquote or list item is ALSO wrapped by the syntax
    // highlighter (t.quote → grey, t.list → plain), and that inner span's colour
    // would otherwise win over the outer .cm-link. This descendant selector has
    // higher specificity than the highlighter's single-class rules, so the link
    // stays blue wherever it appears.
    '.cm-link span': {
      color: c.blue,
    },
    // Wikilinks (`[[…]]`) are internal navigation, not web URLs — mauve to set
    // them apart from blue external links and match the theme's accent. Overrides
    // the shared .cm-link colour (and the same descendant-span trick for links
    // sitting inside a list/quote).
    '.cm-wikilink, .cm-wikilink span': {
      color: c.mauve,
    },

    // --- Inline code (`code`) -----------------------------------------------
    // Green + monospace, robust to the block-level highlight colour of a
    // surrounding list/quote (the descendant rule out-specifies the single-class
    // highlighter selectors, same trick as .cm-link span).
    '.cm-inline-code': {
      color: c.green,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '0.9em',
    },
    '.cm-inline-code span': {
      color: c.green,
    },

    // --- Unfurled link card -------------------------------------------------
    '.cm-linkcard': {
      position: 'relative',
      display: 'flex',
      margin: '8px 0',
      border: `1px solid ${c.surface0}`,
      borderRadius: '12px',
      overflow: 'hidden',
      backgroundColor: c.mantle,
      cursor: 'pointer',
      maxWidth: '520px',
      WebkitTouchCallout: 'none',
    },
    '.cm-linkcard-img': {
      width: '104px',
      minWidth: '104px',
      objectFit: 'cover',
      backgroundColor: c.surface0,
    },
    '.cm-linkcard-body': {
      flex: '1',
      minWidth: '0',
      // Extra right padding reserves room for the copy button.
      padding: '10px 48px 10px 13px',
      fontFamily: '-apple-system, Roboto, sans-serif',
    },
    '.cm-linkcard-title': {
      color: c.text,
      fontSize: '15px',
      fontWeight: '600',
      lineHeight: '1.3',
      display: '-webkit-box',
      '-webkit-line-clamp': '2',
      '-webkit-box-orient': 'vertical',
      overflow: 'hidden',
    },
    '.cm-linkcard-desc': {
      color: c.subtext0,
      fontSize: '13px',
      lineHeight: '1.35',
      marginTop: '3px',
      display: '-webkit-box',
      '-webkit-line-clamp': '2',
      '-webkit-box-orient': 'vertical',
      overflow: 'hidden',
    },
    '.cm-linkcard-domain': {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      marginTop: '8px',
      color: c.overlay1,
      fontSize: '12px',
    },
    '.cm-linkcard-favicon': {
      width: '15px',
      height: '15px',
      borderRadius: '3px',
      flexShrink: '0',
    },

    // --- Rendered image (pasted image URL or ![alt](url)) -------------------
    '.cm-image-block': {
      position: 'relative',
      display: 'block',
      width: 'fit-content',
      maxWidth: '100%',
      margin: '8px 0',
      cursor: 'pointer',
      WebkitTouchCallout: 'none',
    },
    '.cm-image-block .cm-image-img': {
      display: 'block',
      maxWidth: '100%',
      maxHeight: '420px',
      borderRadius: '10px',
      border: `1px solid ${c.surface0}`,
      objectFit: 'contain',
      backgroundColor: c.mantle,
    },
    '.cm-image-inline': {
      display: 'inline-block',
      verticalAlign: 'middle',
      cursor: 'pointer',
    },
    '.cm-image-inline .cm-image-img': {
      maxWidth: '100%',
      maxHeight: '260px',
      borderRadius: '6px',
    },
    '.cm-image-broken': {
      color: c.subtext0,
      fontStyle: 'italic',
    },

    // --- Blockquote (Obsidian-style bar) ------------------------------------
    // A continuous accent bar down the left, muted text, and a faint surface
    // tint. The raw `>` markers are hidden in live preview (see SYNTAX_MARKS).
    '.cm-blockquote': {
      backgroundColor: c.mantle,
      borderLeft: `3px solid ${c.mauve}`,
      color: c.subtext0,
      paddingLeft: '16px',
    },
    '.cm-blockquote-first': {
      paddingTop: '3px',
      borderTopRightRadius: '8px',
    },
    '.cm-blockquote-last': {
      paddingBottom: '3px',
      borderBottomRightRadius: '8px',
    },

    // --- Ask card (/ask …) --------------------------------------------------
    // A self-contained card: the question is always visible; the streamed answer
    // lives in a collapsible accordion below it.
    '.cm-ask': {
      margin: '10px 0',
      border: `1px solid ${c.surface0}`,
      borderRadius: '12px',
      backgroundColor: c.mantle,
      overflow: 'hidden',
      fontFamily: '-apple-system, Roboto, sans-serif',
      maxWidth: '640px',
      WebkitTouchCallout: 'none',
    },
    '.cm-ask-error': { borderColor: c.red },
    '.cm-ask-head': {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '11px 12px',
      cursor: 'pointer',
      userSelect: 'none',
    },
    '.cm-ask-chev': {
      color: c.mauve,
      fontSize: '13px',
      lineHeight: '1.5',
      transition: 'transform 0.12s ease',
      transform: 'rotate(0deg)',
    },
    '.cm-ask-chev.cm-open': { transform: 'rotate(90deg)' },
    '.cm-ask-q': {
      flex: '1',
      minWidth: '0',
      color: c.text,
      fontSize: '15px',
      fontWeight: '600',
      lineHeight: '1.4',
    },
    '.cm-ask-badge': {
      flexShrink: '0',
      fontSize: '11px',
      color: c.overlay1,
      alignSelf: 'center',
    },
    // Still used by the /pair chip's dismiss button.
    '.cm-ask-del': {
      flexShrink: '0',
      color: c.overlay1,
      fontSize: '16px',
      lineHeight: '1',
      padding: '0 2px',
      cursor: 'pointer',
    },
    '.cm-ask-body': {
      position: 'relative',
      padding: '0 12px 12px 12px',
      borderTop: `1px solid ${c.surface0}`,
    },
    '.cm-ask-answer': {
      color: c.subtext0,
      fontSize: '14px',
      lineHeight: '1.5',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      paddingTop: '10px',
    },
    '.cm-ask-answer-err': { color: c.red },
    '.cm-ask-thinking': {
      display: 'inline-flex',
      gap: '4px',
      alignItems: 'center',
      paddingTop: '12px',
      color: c.overlay1,
      fontSize: '13px',
    },
    '.cm-ask-dot': {
      width: '5px',
      height: '5px',
      borderRadius: '50%',
      backgroundColor: c.overlay1,
      display: 'inline-block',
      animation: 'cm-ask-blink 1.2s infinite both',
    },
    '.cm-ask-dot:nth-child(2)': { animationDelay: '0.2s' },
    '.cm-ask-dot:nth-child(3)': { animationDelay: '0.4s' },
    '@keyframes cm-ask-blink': {
      '0%, 80%, 100%': { opacity: '0.25' },
      '40%': { opacity: '1' },
    },

    // Follow-up composer pinned under a finished answer: a one-line input plus a
    // send button, separated from the answer by a hairline rule.
    '.cm-ask-foot': {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginTop: '12px',
      paddingTop: '12px',
      borderTop: `1px solid ${c.surface0}`,
    },
    '.cm-ask-followup': {
      flex: '1',
      minWidth: '0',
      backgroundColor: c.base,
      border: `1px solid ${c.surface1}`,
      borderRadius: '9px',
      color: c.text,
      fontFamily: '-apple-system, Roboto, sans-serif',
      fontSize: '14px',
      lineHeight: '1.4',
      padding: '8px 12px',
      outline: 'none',
    },
    '.cm-ask-followup::placeholder': { color: c.overlay1 },
    '.cm-ask-followup:focus': { borderColor: c.mauve },
    '.cm-ask-send': {
      flexShrink: '0',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '34px',
      height: '34px',
      color: c.base,
      backgroundColor: c.mauve,
      borderRadius: '9px',
      cursor: 'pointer',
      userSelect: 'none',
    },
    '.cm-ask-send svg': { display: 'block', width: '17px', height: '17px' },

    // --- Chat transcript (/chat …) ------------------------------------------
    // Each follow-up turn shows its question as a small prompt bubble above the
    // answer, so a multi-turn thread reads as a back-and-forth.
    '.cm-chat-q': {
      margin: '16px 0 8px',
      padding: '7px 11px',
      borderRadius: '9px',
      backgroundColor: c.surface0,
      color: c.subtext0,
      fontSize: '14px',
      lineHeight: '1.4',
      whiteSpace: 'pre-wrap',
    },

    // --- Pair chip (/pair …) ------------------------------------------------
    '.cm-ask-pair': {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '9px 12px',
      fontSize: '13px',
      color: c.subtext0,
      maxWidth: '640px',
    },
    '.cm-ask-pair.cm-ask-error': { color: c.red },
    '.cm-ask-pair-ok': { color: c.green, borderColor: c.green },

    // --- Clean bar (/clean …) -----------------------------------------------
    // A slim status chip while cleaning, then an Accept / Reject review bar.
    '.cm-clean': {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '9px 12px',
      fontSize: '13px',
      color: c.subtext0,
      maxWidth: '640px',
    },
    '.cm-clean-review': {
      borderColor: c.mauve,
      backgroundColor: c.surface0,
      color: c.text,
    },
    '.cm-clean-icon': { flexShrink: '0', fontSize: '14px' },
    '.cm-clean-text': { flex: '1', minWidth: '0' },
    '.cm-clean-dots': { flexShrink: '0', paddingTop: '0' },
    '.cm-clean-actions': { flexShrink: '0', display: 'flex', gap: '8px' },
    '.cm-clean-btn': {
      fontFamily: '-apple-system, Roboto, sans-serif',
      fontSize: '13px',
      fontWeight: '600',
      padding: '6px 14px',
      borderRadius: '8px',
      border: 'none',
      cursor: 'pointer',
      userSelect: 'none',
    },
    '.cm-clean-accept': { color: c.base, backgroundColor: c.green },
    '.cm-clean-reject': { color: c.subtext0, backgroundColor: c.surface1 },

    // --- Record card (/record …) --------------------------------------------
    // One round Record/Stop button beside a title + status line; a live timer
    // (with a pulsing dot) replaces the title while capturing.
    '.cm-rec': {
      display: 'block',
      padding: '10px 12px',
      maxWidth: '640px',
      // The card's title/sub text lives inside CM's contenteditable content, so
      // a long-press on the card would otherwise start Android's text selection
      // (stealing the play button's hold-to-delete gesture). Nothing in the card
      // is meant to be selected, so turn selection off for the whole card.
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
    },
    '.cm-rec-row': { display: 'flex', alignItems: 'center', gap: '12px' },
    '.cm-rec-btn': {
      flexShrink: '0',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '44px',
      height: '44px',
      padding: '0',
      border: 'none',
      borderRadius: '50%',
      cursor: 'pointer',
      // No native long-press selection/callout on the button; manipulation drops
      // the tap delay. (Hold-to-delete lives on the card + Export button now.)
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
      touchAction: 'manipulation',
      color: c.base,
    },
    '.cm-rec-btn svg': { display: 'block', width: '22px', height: '22px' },
    // Go = start / play (mauve); Stop = record-stop (red). Same button, swapped
    // by state. Armed = the play button held into Delete mode (red).
    '.cm-rec-go': { backgroundColor: c.mauve },
    '.cm-rec-stop': { backgroundColor: c.red, animation: 'cm-rec-glow 1.6s ease-in-out infinite' },
    '.cm-rec-armed': { backgroundColor: c.red },
    '.cm-rec-busy': { opacity: '0.6' },
    '.cm-rec-disabled': { cursor: 'default', opacity: '0.6', pointerEvents: 'none' },
    '.cm-rec-meta': { flex: '1', minWidth: '0' },
    '.cm-rec-title': {
      color: c.text,
      fontSize: '15px',
      fontWeight: '600',
      lineHeight: '1.3',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    '.cm-rec-live': { display: 'flex', alignItems: 'center', gap: '8px' },
    '.cm-rec-time': { fontVariantNumeric: 'tabular-nums', color: c.red, fontWeight: '700' },
    '.cm-rec-pulse': {
      width: '9px',
      height: '9px',
      borderRadius: '50%',
      backgroundColor: c.red,
      animation: 'cm-ask-blink 1.2s ease-in-out infinite',
    },
    '.cm-rec-sub': { color: c.subtext0, fontSize: '12px', lineHeight: '1.35', marginTop: '2px' },
    '.cm-rec.cm-ask-error .cm-rec-sub': { color: c.red },
    // Top-right corner control: the delete × (non-stopped) or the Export icon
    // (stopped). Shared placement; each adds its own glyph styling.
    '.cm-rec-corner': {
      flexShrink: '0',
      alignSelf: 'flex-start',
      color: c.overlay1,
      cursor: 'pointer',
      userSelect: 'none',
    },
    '.cm-rec-del': { fontSize: '18px', lineHeight: '1', padding: '2px 4px' },
    '.cm-rec-export': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2px',
    },
    '.cm-rec-export svg': { display: 'block', width: '19px', height: '19px' },
    '.cm-rec-export:active': { color: c.mauve },
    // Export corner armed as Delete (after a long-press on the card). Matches
    // the /ask card's delete button exactly: a red-bordered rounded box on
    // surface0 with a 16px red trash glyph (see .cm-copy-btn.cm-del-btn above).
    '.cm-rec-corner-del': {
      color: c.red,
      backgroundColor: c.surface0,
      border: `1px solid ${c.red}`,
      borderRadius: '7px',
      padding: '6px',
    },
    '.cm-rec-corner-del svg': { width: '16px', height: '16px' },
    '@keyframes cm-rec-glow': {
      '0%, 100%': { boxShadow: `0 0 0 0 ${c.red}66` },
      '50%': { boxShadow: `0 0 0 6px ${c.red}00` },
    },

    // --- Slash-command autocomplete menu ------------------------------------
    // Each row stacks the command name over a wrapping description, so the
    // menu sizes to its content instead of cropping the detail text.
    '.cm-tooltip.cm-tooltip-autocomplete': {
      border: `1px solid ${c.surface1}`,
      borderRadius: '12px',
      backgroundColor: c.mantle,
      boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
      overflow: 'hidden',
      minWidth: '260px',
      maxWidth: '340px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: '-apple-system, Roboto, sans-serif',
      whiteSpace: 'normal',
      maxHeight: '18em',
      padding: '4px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: '2px',
      padding: '8px 12px',
      borderRadius: '8px',
      lineHeight: '1.35',
      color: c.text,
      whiteSpace: 'normal',
      overflow: 'visible',
      textOverflow: 'clip',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: c.surface0,
      color: c.text,
    },
    '.cm-completionLabel': {
      color: c.mauve,
      fontWeight: '600',
      fontSize: '15px',
    },
    '.cm-completionMatchedText': {
      textDecoration: 'none',
      color: c.blue,
    },
    '.cm-completionDetail': {
      fontStyle: 'normal',
      fontSize: '12.5px',
      color: c.subtext0,
      whiteSpace: 'normal',
      overflow: 'visible',
      textOverflow: 'clip',
    },
};

export const theme = EditorView.theme({ ...chrome, ...components }, { dark: true });
export const answerTheme = EditorView.theme({ ...answerChrome, ...components }, { dark: true });

// How markdown tokens (and nested code) are painted. Syntax marks (#, *, `) are
// dimmed like Obsidian; headings are larger and bold; code tokens get the full
// Catppuccin palette so fenced blocks read like a real editor.
export const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.8em', fontWeight: 'bold', color: c.text },
  { tag: t.heading2, fontSize: '1.5em', fontWeight: 'bold', color: c.text },
  { tag: t.heading3, fontSize: '1.25em', fontWeight: 'bold', color: c.text },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: 'bold', color: c.text },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: c.blue, textDecoration: 'underline' },
  { tag: t.url, color: c.blue },
  { tag: [t.monospace], color: c.green },
  { tag: t.quote, color: c.subtext0 },
  { tag: t.list, color: c.text },
  // The literal syntax punctuation (#, *, -, `, >) — dimmed.
  { tag: [t.processingInstruction, t.meta], color: c.overlay1 },

  // Code tokens inside fenced blocks (js/ts/css/html).
  { tag: [t.keyword, t.modifier], color: c.mauve },
  { tag: [t.controlKeyword, t.operatorKeyword], color: c.mauve },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.blue },
  { tag: [t.string, t.special(t.string), t.regexp], color: c.green },
  { tag: [t.number, t.bool, t.null, t.atom], color: c.peach },
  { tag: [t.comment, t.lineComment, t.blockComment], color: c.overlay1, fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: c.yellow },
  { tag: [t.propertyName, t.attributeName], color: c.teal },
  { tag: [t.tagName], color: c.blue },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: c.subtext0 },
  { tag: [t.variableName, t.definition(t.variableName)], color: c.text },
  { tag: t.escape, color: c.peach },
]);
