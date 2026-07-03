import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { tags as t } from '@lezer/highlight';

/**
 * The CodeMirror 6 markdown editor that runs inside the React Native WebView.
 *
 * Source-mode markdown (the document is plain markdown text — the app's storage
 * format, so no data migration). On top of syntax highlighting this layer adds
 * Obsidian-style live-preview decorations: interactive task checkboxes and
 * Claude-style fenced-code cards with a copy button.
 *
 * Bridge with the RN side is JSON messages over `window.ReactNativeWebView`:
 *   RN → web:  window.__setDoc(markdown)   (called via injectJavaScript)
 *   web → RN:  { type: 'ready' } once mounted, { type: 'change', text } on edits.
 */

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

const theme = EditorView.theme(
  {
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
      paddingTop: '2.4em',
      borderTopLeftRadius: '10px',
      borderTopRightRadius: '10px',
      borderTop: `1px solid ${c.surface0}`,
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
      gap: '0.35em',
      padding: '0.28em 0.7em',
      fontFamily: '-apple-system, Roboto, sans-serif',
      fontSize: '12px',
      fontWeight: '600',
      color: c.subtext0,
      backgroundColor: c.surface0,
      border: `1px solid ${c.surface1}`,
      borderRadius: '7px',
      cursor: 'pointer',
      userSelect: 'none',
      zIndex: '2',
    },
    '.cm-copy-btn.cm-copied': {
      color: c.green,
      borderColor: c.green,
    },

    // --- Links --------------------------------------------------------------
    '.cm-link': {
      color: c.blue,
      textDecoration: 'underline',
      cursor: 'pointer',
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
      padding: '10px 62px 10px 13px',
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
      display: 'block',
      margin: '8px 0',
      cursor: 'pointer',
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
    },
    '.cm-ask-error': { borderColor: c.red },
    '.cm-ask-head': {
      display: 'flex',
      alignItems: 'flex-start',
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
      // Room for the copy button.
      paddingRight: '52px',
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
    // Blinking caret appended to the answer while tokens are still streaming.
    '.cm-ask-cursor': {
      display: 'inline-block',
      width: '2px',
      height: '1em',
      marginLeft: '1px',
      verticalAlign: '-0.15em',
      backgroundColor: c.mauve,
      animation: 'cm-ask-blink 1s steps(1) infinite',
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
  },
  { dark: true },
);

// How markdown tokens (and nested code) are painted. Syntax marks (#, *, `) are
// dimmed like Obsidian; headings are larger and bold; code tokens get the full
// Catppuccin palette so fenced blocks read like a real editor.
const highlight = HighlightStyle.define([
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

function post(msg) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
}

// An html-source WebView is not a secure context, so navigator.clipboard is
// unavailable; the execCommand path works from within a tap (user gesture).
function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return;
    }
  } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) {}
  document.body.removeChild(ta);
}

// The shared "Copy" button (code cards and link cards use the same UI). Copies
// `text`, flips to "Copied" briefly, and swallows the tap so it doesn't reach
// the surrounding widget (which would open the link / move the caret).
function makeCopyButton(text) {
  const btn = document.createElement('span');
  btn.className = 'cm-copy-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    copyText(text);
    btn.textContent = 'Copied';
    btn.classList.add('cm-copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('cm-copied');
    }, 1200);
  });
  return btn;
}

// --- /ask + /pair markers ---------------------------------------------------
// An ask/pair block is persisted as a single-line HTML comment carrying a
// base64-encoded JSON payload: `<!--ai <b64>-->`. base64's alphabet can't
// contain `-->`, so the marker is robust no matter what the answer text holds
// (code, arrows, quotes), and it stays on one line so line-based detection is
// trivial. The card widget renders it; the raw marker is only ever seen if the
// widget can't mount.
const AI_MARK_RE = /^<!--ai ([A-Za-z0-9+/=]+)-->$/;

// UTF-8-safe base64 (btoa is Latin1-only; answers contain emoji/Unicode). Built
// with a loop rather than spread so large answers don't blow the call stack.
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Encode a payload object into a marker line; decode a line back to the object
// (null if the line isn't an ai marker or is malformed).
function encodeAiMarker(obj) {
  return '<!--ai ' + b64encode(JSON.stringify(obj)) + '-->';
}
function parseAiMarker(lineText) {
  const m = AI_MARK_RE.exec(lineText.trim());
  if (!m) return null;
  try {
    const obj = JSON.parse(b64decode(m[1]));
    return obj && obj.kind ? obj : null;
  } catch (e) {
    return null;
  }
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

// Locate the marker line for a given id (used by the RN → web update bridge).
function findAiLine(state, id) {
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const obj = parseAiMarker(line.text);
    if (obj && obj.id === id) return { from: line.from, to: line.to, obj };
  }
  return null;
}

/**
 * Interactive task-list checkbox. Replaces the `[ ]`/`[x]` marker; a tap toggles
 * the underlying markdown. The live position is resolved at tap time via
 * posAtDOM so the toggle stays correct even as text above shifts.
 */
class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other.checked === this.checked;
  }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'cm-task' + (this.checked ? ' cm-task-done' : '');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(box);
      const cur = view.state.doc.sliceString(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(cur)) return;
      view.dispatch({
        changes: { from: pos, to: pos + 3, insert: cur === '[ ]' ? '[x]' : '[ ]' },
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** Renders an unordered-list marker (`-`/`*`/`+`) as a real "•" bullet. */
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const b = document.createElement('span');
    b.className = 'cm-bullet';
    b.textContent = '•';
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

/** Claude-style "Copy" button pinned to the top-right of a fenced code card. */
class CopyButtonWidget extends WidgetType {
  constructor(code) {
    super();
    this.code = code;
  }
  eq(other) {
    return other.code === this.code;
  }
  toDOM() {
    return makeCopyButton(this.code);
  }
  ignoreEvent() {
    return true;
  }
}

const HIDE = Decoration.replace({});
// Marks a run of text as a tappable link; the URL rides along as a data attr so
// the mousedown handler can hand it to RN (see openLinks / NoteEditorWebView).
function linkDeco(url) {
  return Decoration.mark({ class: 'cm-link', attributes: { 'data-url': url } });
}

// A bare URL is treated as an image when its path ends in a known image
// extension (query string / hash allowed after it), e.g.
//   https://study.com/cimages/videopreview/7m7z42z3x3.jpg
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|apng|ico)(?:[?#][^\s]*)?$/i;
function isImageUrl(url) {
  return IMAGE_URL_RE.test(url);
}

// The alt text of a markdown image `![alt](url)`.
function imageAlt(raw) {
  const m = /^!\[([^\]]*)\]/.exec(raw);
  return m ? m[1] : '';
}

/**
 * A rendered image — either a bare image URL pasted on its own line or a
 * markdown `![alt](url)`. Block variant sits on its own line; inline variant is
 * used for an image embedded mid-prose. Tapping opens the source in the browser;
 * a load failure falls back to showing the alt text / URL.
 */
class ImageWidget extends WidgetType {
  constructor(url, alt, block) {
    super();
    this.url = url;
    this.alt = alt || '';
    this.block = block;
  }
  eq(other) {
    return other.url === this.url && other.alt === this.alt && other.block === this.block;
  }
  toDOM() {
    const wrap = document.createElement(this.block ? 'div' : 'span');
    wrap.className = this.block ? 'cm-image-block' : 'cm-image-inline';
    wrap.setAttribute('data-url', this.url);

    const img = document.createElement('img');
    img.className = 'cm-image-img';
    img.src = this.url;
    if (this.alt) img.alt = this.alt;
    img.addEventListener('error', () => {
      wrap.classList.add('cm-image-broken');
      wrap.textContent = this.alt || this.url;
    });
    wrap.appendChild(img);

    // Own the tap so it opens the image instead of moving the caret into it.
    wrap.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    wrap.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'openUrl', url: this.url });
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function domainFromUrl(url) {
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, '') : url;
}
function faviconFor(domain) {
  return (
    'https://www.google.com/s2/favicons?domain=' +
    encodeURIComponent(domain) +
    '&sz=64'
  );
}

// Preview metadata, keyed by URL, filled in asynchronously by RN via
// window.__setPreview. Held in editor state so the card decorations recompute
// when it arrives. Value: { domain, title?, description?, image?, favicon?, error? }.
const setPreviewEffect = StateEffect.define();
const previewField = StateField.define({
  create: () => Object.create(null),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setPreviewEffect)) {
        next = { ...next, [e.value.url]: e.value.data };
      }
    }
    return next;
  },
});

// Live streaming answers, keyed by ask id: { a, status }. Filled token-by-token
// by RN via window.__aiStream so the answer can grow WITHOUT rewriting the
// document on every chunk — that keeps the user's caret still and avoids a save
// storm. The final answer is committed to the doc once, on completion.
const setAskLive = StateEffect.define();
const clearAskLive = StateEffect.define();
const askLiveField = StateField.define({
  create: () => Object.create(null),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setAskLive)) {
        next = { ...next, [e.value.id]: { a: e.value.a, status: e.value.status } };
      } else if (e.is(clearAskLive)) {
        if (next[e.value] !== undefined) {
          next = { ...next };
          delete next[e.value];
        }
      }
    }
    return next;
  },
});

/**
 * A "pasted link" is a bare URL alone on its line — that's what we unfurl into a
 * card (a URL inside prose stays an inline link). Yields the card-worthy URLs.
 */
function eachCardUrl(state, fn) {
  syntaxTree(state).iterate({
    enter: node => {
      if (node.name !== 'URL') return;
      const parent = node.node.parent;
      if (parent && (parent.name === 'Link' || parent.name === 'Autolink' || parent.name === 'Image')) return;
      const line = state.doc.lineAt(node.from);
      const url = state.doc.sliceString(node.from, node.to);
      if (line.text.trim() !== url) return;
      // Image URLs render as the image itself (see eachBlockImage), not a card.
      if (isImageUrl(url)) return;
      fn(url, line);
    },
  });
}

/**
 * An image alone on its line — either a bare image URL or a markdown
 * `![alt](url)` — which we render as a block image. Yields (url, alt, line).
 */
function eachBlockImage(state, fn) {
  syntaxTree(state).iterate({
    enter: node => {
      if (node.name === 'Image') {
        const raw = state.doc.sliceString(node.from, node.to);
        const line = state.doc.lineAt(node.from);
        if (line.text.trim() !== raw) return; // inline image — handled elsewhere
        const urlNode = node.node.getChild('URL');
        if (!urlNode) return;
        const url = state.doc.sliceString(urlNode.from, urlNode.to);
        fn(url, imageAlt(raw), line);
        return;
      }
      if (node.name === 'URL') {
        const parent = node.node.parent;
        if (parent && (parent.name === 'Link' || parent.name === 'Autolink' || parent.name === 'Image')) return;
        const url = state.doc.sliceString(node.from, node.to);
        if (!isImageUrl(url)) return;
        const line = state.doc.lineAt(node.from);
        if (line.text.trim() !== url) return;
        fn(url, '', line);
      }
    },
  });
}

// The rich card rendered beneath a pasted link.
class LinkCardWidget extends WidgetType {
  constructor(url, data) {
    super();
    this.url = url;
    this.data = data;
  }
  get sig() {
    const d = this.data;
    if (!d) return this.url + '|loading';
    return this.url + '|' + (d.error ? 'e' : '') + (d.title || '') + (d.image || '') + (d.description || '');
  }
  eq(other) {
    return other.sig === this.sig;
  }
  toDOM() {
    const d = this.data;
    const domain = d ? d.domain : domainFromUrl(this.url);
    const card = document.createElement('div');
    card.className = 'cm-linkcard';
    card.setAttribute('data-url', this.url);

    if (d && d.image) {
      const img = document.createElement('img');
      img.className = 'cm-linkcard-img';
      img.src = d.image;
      img.addEventListener('error', () => img.remove());
      card.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'cm-linkcard-body';

    const title = document.createElement('div');
    title.className = 'cm-linkcard-title';
    title.textContent = d && d.title ? d.title : d && d.error ? domain : 'Loading preview…';
    body.appendChild(title);

    if (d && d.description) {
      const desc = document.createElement('div');
      desc.className = 'cm-linkcard-desc';
      desc.textContent = d.description;
      body.appendChild(desc);
    }

    const dom = document.createElement('div');
    dom.className = 'cm-linkcard-domain';
    const fav = document.createElement('img');
    fav.className = 'cm-linkcard-favicon';
    fav.src = (d && d.favicon) || faviconFor(domain);
    fav.addEventListener('error', () => fav.remove());
    dom.appendChild(fav);
    const dl = document.createElement('span');
    dl.textContent = domain;
    dom.appendChild(dl);
    body.appendChild(dom);

    card.appendChild(body);

    // Same copy button as the code cards, pinned top-right — copies the URL.
    card.appendChild(makeCopyButton(this.url));

    // Own the tap so it opens instead of moving the caret into the widget.
    card.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    card.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'openUrl', url: this.url });
    });
    return card;
  }
  ignoreEvent() {
    return true;
  }
}

// Resolve the marker line a card widget sits on, at interaction time, so edits
// above it don't invalidate a captured position (mirrors CheckboxWidget).
function aiLineOf(view, el) {
  const pos = view.posAtDOM(el);
  return view.state.doc.lineAt(pos);
}

// Rewrite a card's persisted payload in place (toggle collapse, commit answer).
function updateAiMarker(view, el, patch) {
  const line = aiLineOf(view, el);
  const obj = parseAiMarker(line.text);
  if (!obj) return;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: encodeAiMarker({ ...obj, ...patch }) },
  });
}

/**
 * The /ask card: the question is always visible in the header; tapping it
 * expands/collapses the accordion holding the streamed answer. Also renders the
 * compact /pair connection chip. Question + collapse state persist in the doc;
 * the answer streams from a live field until it's committed on completion.
 */
class AiCardWidget extends WidgetType {
  constructor(obj, live) {
    super();
    this.obj = obj;
    this.live = live || null;
  }
  get answer() {
    return this.live && this.live.a != null ? this.live.a : this.obj.a || '';
  }
  get status() {
    return this.live ? this.live.status : this.obj.status || 'done';
  }
  get sig() {
    const o = this.obj;
    return [o.kind, o.id, o.q, o.msg, o.open, this.status, this.answer].join('');
  }
  eq(other) {
    return other.sig === this.sig;
  }
  toDOM(view) {
    return this.obj.kind === 'pair' ? this.pairDOM(view) : this.askDOM(view);
  }
  askDOM(view) {
    const open = this.obj.open !== false;
    const status = this.status;
    const answer = this.answer;

    const card = document.createElement('div');
    card.className = 'cm-ask' + (status === 'error' ? ' cm-ask-error' : '');

    const head = document.createElement('div');
    head.className = 'cm-ask-head';

    const chev = document.createElement('span');
    chev.className = 'cm-ask-chev' + (open ? ' cm-open' : '');
    chev.textContent = '▶';
    head.appendChild(chev);

    const q = document.createElement('div');
    q.className = 'cm-ask-q';
    q.textContent = this.obj.q || '';
    head.appendChild(q);

    if (status === 'streaming') {
      const badge = document.createElement('span');
      badge.className = 'cm-ask-badge';
      badge.textContent = '···';
      head.appendChild(badge);
    }

    const del = document.createElement('span');
    del.className = 'cm-ask-del';
    del.textContent = '×';
    del.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    del.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const line = aiLineOf(view, card);
      const to = Math.min(line.to + 1, view.state.doc.length);
      view.dispatch({ changes: { from: line.from, to } });
    });
    head.appendChild(del);

    head.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    head.addEventListener('click', e => {
      if (e.target === del) return;
      e.preventDefault();
      e.stopPropagation();
      updateAiMarker(view, card, { open: !open });
    });
    card.appendChild(head);

    if (open) {
      const body = document.createElement('div');
      body.className = 'cm-ask-body';

      const empty = !answer;
      if (status === 'error') {
        if (answer) {
          const ans = document.createElement('div');
          ans.className = 'cm-ask-answer';
          ans.textContent = answer;
          body.appendChild(ans);
        }
        const err = document.createElement('div');
        err.className = 'cm-ask-answer cm-ask-answer-err';
        err.textContent = this.obj.msg || 'Something went wrong.';
        body.appendChild(err);
      } else if (empty && status === 'streaming') {
        const think = document.createElement('div');
        think.className = 'cm-ask-thinking';
        for (let i = 0; i < 3; i++) {
          const dot = document.createElement('span');
          dot.className = 'cm-ask-dot';
          think.appendChild(dot);
        }
        const label = document.createElement('span');
        label.textContent = 'Thinking…';
        think.appendChild(label);
        body.appendChild(think);
      } else {
        const ans = document.createElement('div');
        ans.className = 'cm-ask-answer';
        ans.textContent = answer;
        if (status === 'streaming') {
          const cur = document.createElement('span');
          cur.className = 'cm-ask-cursor';
          ans.appendChild(cur);
        }
        body.appendChild(ans);
        if (answer) body.appendChild(makeCopyButton(answer));
      }
      card.appendChild(body);
    }
    return card;
  }
  pairDOM(view) {
    const status = this.obj.status || 'pending';
    const card = document.createElement('div');
    card.className =
      'cm-ask cm-ask-pair' +
      (status === 'error' ? ' cm-ask-error' : status === 'ok' ? ' cm-ask-pair-ok' : '');

    const icon = document.createElement('span');
    icon.textContent = status === 'ok' ? '🔗' : status === 'error' ? '⚠️' : '⏳';
    card.appendChild(icon);

    const text = document.createElement('span');
    text.textContent =
      this.obj.msg || (status === 'ok' ? 'Connected' : status === 'error' ? 'Pairing failed' : 'Pairing…');
    card.appendChild(text);

    const del = document.createElement('span');
    del.className = 'cm-ask-del';
    del.textContent = '×';
    del.style.marginLeft = 'auto';
    del.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    del.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const line = aiLineOf(view, card);
      const to = Math.min(line.to + 1, view.state.doc.length);
      view.dispatch({ changes: { from: line.from, to } });
    });
    card.appendChild(del);
    return card;
  }
  ignoreEvent() {
    return true;
  }
}

// Every line that is an /ask or /pair marker (yields the parsed payload + line).
function eachAiLine(state, fn) {
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const obj = parseAiMarker(line.text);
    if (obj) fn(obj, line);
  }
}

// Block widgets must come from a StateField (the editor computes vertical layout
// before running view plugins), so the cards live here rather than in a plugin.
function buildCards(state) {
  const previews = state.field(previewField);
  const askLive = state.field(askLiveField);
  // Lines touched by a selection stay raw so the URL can be edited.
  const activeLines = new Set();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  const marks = [];
  eachCardUrl(state, (url, line) => {
    if (activeLines.has(line.number)) return; // editing this line — show raw URL
    // Replace the whole URL line with the card so the raw URL is never shown.
    marks.push(
      Decoration.replace({
        widget: new LinkCardWidget(url, previews[url]),
        block: true,
      }).range(line.from, line.to),
    );
  });
  eachBlockImage(state, (url, alt, line) => {
    if (activeLines.has(line.number)) return; // editing this line — show raw text
    marks.push(
      Decoration.replace({
        widget: new ImageWidget(url, alt, true),
        block: true,
      }).range(line.from, line.to),
    );
  });
  // Ask/pair cards always render as their widget (never revealed as raw base64),
  // so the marker line is replaced whether or not the cursor is on it.
  eachAiLine(state, (obj, line) => {
    marks.push(
      Decoration.replace({
        widget: new AiCardWidget(obj, askLive[obj.id]),
        block: true,
      }).range(line.from, line.to),
    );
  });
  return Decoration.set(marks, true);
}

const cardField = StateField.define({
  create: state => buildCards(state),
  update(value, tr) {
    // Rebuild on edits, on cursor moves (reveal/hide the raw URL), when a fetched
    // preview arrives, and when a streamed answer chunk lands.
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some(
        e => e.is(setPreviewEffect) || e.is(setAskLive) || e.is(clearAskLive),
      )
    ) {
      return buildCards(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

// Side effects (asking RN to fetch) belong in a plugin, not the pure field.
// `requested` dedupes so each URL is fetched at most once per session.
const requested = new Set();
const previewFetcher = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.scan(view.state);
    }
    update(u) {
      if (u.docChanged) this.scan(u.state);
    }
    scan(state) {
      const previews = state.field(previewField);
      eachCardUrl(state, url => {
        if (!previews[url] && !requested.has(url)) {
          requested.add(url);
          post({ type: 'fetchPreview', url });
        }
      });
    }
  },
);
// Lezer node names for the punctuation we hide (inline emphasis/code/strike, the
// leading `#` of headings, and the `>` of blockquotes — the bar replaces it).
// List bullets are left visible (a BulletWidget swaps them for a dot).
const SYNTAX_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
  'QuoteMark',
]);

/**
 * Obsidian-style live preview: hide the markdown syntax punctuation so the text
 * renders "clean", reveal it again on whichever line(s) the cursor/selection is
 * on (so it stays editable), and swap task markers for interactive checkboxes.
 */
function buildLivePreview(view) {
  const { state } = view;
  // Every line touched by a selection stays "revealed" (raw text shown).
  const activeLines = new Set();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  const marks = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: node => {
        const active = activeLines.has(state.doc.lineAt(node.from).number);

        // Images: `![alt](url)` renders as the picture. A solo image is replaced
        // by a block image (see cardField); an image mid-prose renders inline
        // here. Either way skip children so the inner URL isn't re-processed.
        if (node.name === 'Image') {
          if (active) return false; // show raw markdown so it stays editable
          const raw = state.doc.sliceString(node.from, node.to);
          const line = state.doc.lineAt(node.from);
          if (line.text.trim() === raw) return false; // solo — block image owns it
          const urlNode = node.node.getChild('URL');
          if (!urlNode) return false;
          const url = state.doc.sliceString(urlNode.from, urlNode.to);
          marks.push(
            Decoration.replace({
              widget: new ImageWidget(url, imageAlt(raw), false),
            }).range(node.from, node.to),
          );
          return false;
        }

        // Links: render clean + tappable. `[text](url)` → "text", `<url>` → url,
        // and bare GFM URLs stay as-is; all carry the URL for the tap handler.
        if (node.name === 'Link' || node.name === 'Autolink') {
          // On the active line show raw markdown; skip children either way so the
          // inner URL node isn't re-processed as a bare URL below.
          if (active) return false;
          const urlNode = node.node.getChild('URL');
          const url = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : null;
          if (!url) return false;
          if (node.name === 'Autolink') {
            marks.push(HIDE.range(node.from, node.from + 1)); // "<"
            marks.push(HIDE.range(node.to - 1, node.to)); // ">"
            marks.push(linkDeco(url).range(urlNode.from, urlNode.to));
          } else {
            const textFrom = node.from + 1; // just past "["
            const textTo = urlNode.from - 2; // the "]" before "](url)"
            if (textTo > textFrom) {
              marks.push(HIDE.range(node.from, textFrom)); // "["
              marks.push(linkDeco(url).range(textFrom, textTo));
              marks.push(HIDE.range(textTo, node.to)); // "](url)"
            } else {
              marks.push(HIDE.range(node.from, node.to)); // empty-text link
            }
          }
          return false;
        }
        if (node.name === 'URL') {
          // A bare URL — its parent Link/Autolink was handled and skipped above.
          if (active) return;
          const url = state.doc.sliceString(node.from, node.to);
          // A solo URL is replaced wholesale by its card (see cardField), so
          // don't render the (often very long) raw URL here. Bare URLs inside
          // prose stay as inline tappable links.
          const line = state.doc.lineAt(node.from);
          if (line.text.trim() === url) return;
          marks.push(linkDeco(url).range(node.from, node.to));
          return;
        }

        if (node.name === 'ListMark') {
          // On the active line show the raw marker so it can be edited.
          if (active) return;
          const mk = state.doc.sliceString(node.from, node.to);
          // Only unordered bullets become dots — leave ordered "1." numbers.
          if (mk !== '-' && mk !== '*' && mk !== '+') return;
          // Task items keep their bullet hidden; the checkbox handler owns them.
          const line = state.doc.lineAt(node.from);
          if (/^\s*\[[ xX]\]/.test(line.text.slice(node.to - line.from))) return;
          marks.push(
            Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
          );
          return;
        }

        if (node.name === 'TaskMarker') {
          // On the active line show raw `- [ ]` text so it can be edited.
          if (active) return;
          const checked = /[xX]/.test(state.doc.sliceString(node.from, node.to));
          // Hide the leading list bullet ("- ", "* ", "+ ") for a clean row.
          const line = state.doc.lineAt(node.from);
          const prefix = line.text.slice(0, node.from - line.from);
          const bullet = /([-*+]\s+)$/.exec(prefix);
          if (bullet) marks.push(HIDE.range(node.from - bullet[1].length, node.from));
          marks.push(
            Decoration.replace({ widget: new CheckboxWidget(checked) }).range(
              node.from,
              node.to,
            ),
          );
          return;
        }

        if (!SYNTAX_MARKS.has(node.name)) return;
        if (active) return;
        let end = node.to;
        // Also swallow the space after a heading's `#` / a quote's `>` so the
        // text isn't inset (the blockquote bar supplies its own indent).
        if (
          (node.name === 'HeaderMark' || node.name === 'QuoteMark') &&
          state.doc.sliceString(end, end + 1) === ' '
        ) {
          end += 1;
        }
        if (end > node.from) marks.push(HIDE.range(node.from, end));
      },
    });
  }
  return Decoration.set(marks, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildLivePreview(view);
    }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildLivePreview(u.view);
      }
    }
  },
  { decorations: v => v.decorations },
);

/**
 * Fenced code "cards": a Catppuccin background spanning every line of a
 * ```-block, rounded on the first/last line, with a copy button on the first.
 */
function buildCodeBlocks(view) {
  const { state } = view;
  const marks = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: node => {
        if (node.name !== 'FencedCode') return;
        const startLine = state.doc.lineAt(node.from).number;
        const endLine = state.doc.lineAt(node.to).number;
        for (let ln = startLine; ln <= endLine; ln++) {
          const line = state.doc.line(ln);
          let cls = 'cm-code-line';
          if (ln === startLine) cls += ' cm-code-first';
          if (ln === endLine) cls += ' cm-code-last';
          marks.push(Decoration.line({ class: cls }).range(line.from));
        }
        const codeText = node.node.getChild('CodeText');
        const code = codeText
          ? state.doc.sliceString(codeText.from, codeText.to)
          : '';
        marks.push(
          Decoration.widget({
            widget: new CopyButtonWidget(code),
            side: -1,
          }).range(node.from),
        );
      },
    });
  }
  return Decoration.set(marks, true);
}

const codeBlocks = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildCodeBlocks(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = buildCodeBlocks(u.view);
      }
    }
  },
  { decorations: v => v.decorations },
);

/**
 * Obsidian-style blockquotes: a continuous accent bar down the left edge of
 * every line in a `>` block, with the ends rounded. The raw `>` markers are
 * hidden by the live-preview layer; this just paints the bar + tint.
 */
function buildBlockquotes(view) {
  const { state } = view;
  const lines = new Set();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: node => {
        if (node.name !== 'Blockquote') return;
        const start = state.doc.lineAt(node.from).number;
        const end = state.doc.lineAt(node.to).number;
        for (let ln = start; ln <= end; ln++) lines.add(ln);
      },
    });
  }
  const marks = [];
  for (const ln of [...lines].sort((a, b) => a - b)) {
    let cls = 'cm-blockquote';
    // Round the ends where the quote starts/stops (nested quotes share a bar).
    if (!lines.has(ln - 1)) cls += ' cm-blockquote-first';
    if (!lines.has(ln + 1)) cls += ' cm-blockquote-last';
    marks.push(Decoration.line({ class: cls }).range(state.doc.line(ln).from));
  }
  return Decoration.set(marks, true);
}

const blockquotes = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildBlockquotes(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = buildBlockquotes(u.view);
      }
    }
  },
  { decorations: v => v.decorations },
);

// Highlight code fenced with a language we bundle a parser for.
function codeLanguages(info) {
  const lang = (info || '').toLowerCase();
  if (['js', 'jsx', 'javascript', 'json', 'ts', 'tsx', 'typescript', 'node'].includes(lang)) {
    return javascript({
      jsx: lang === 'jsx' || lang === 'tsx',
      typescript: lang === 'ts' || lang === 'tsx' || lang === 'typescript',
    }).language;
  }
  if (['css', 'scss', 'less'].includes(lang)) return css().language;
  if (['html', 'htm', 'xml'].includes(lang)) return html().language;
  return null;
}

// A tap on a rendered link hands the URL to RN (which opens the system browser);
// the WebView must not navigate itself, and we swallow the tap so the caret
// doesn't jump into the link.
const openLinks = EditorView.domEventHandlers({
  mousedown(e, view) {
    let el = e.target;
    while (el && el !== view.dom) {
      if (el.dataset && el.dataset.url) {
        post({ type: 'openUrl', url: el.dataset.url });
        e.preventDefault();
        return true;
      }
      el = el.parentElement;
    }
    return false;
  },
});

// Enter on a `/ask <question>` or `/pair <payload>` line turns that line into a
// card and hands the work to RN. Returns true to swallow the newline when it
// fires; otherwise Enter behaves normally.
function aiCommandOnEnter(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  // Only when the caret is at end of the line, so mid-line Enter still splits.
  if (sel.head !== line.to) return false;
  const text = line.text;

  const ask = /^\/ask\s+(.+\S)\s*$/.exec(text);
  if (ask) {
    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'ask',
      id,
      q: ask[1],
      a: '',
      open: true,
      status: 'streaming',
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    post({ type: 'ask', id, question: ask[1] });
    return true;
  }

  const pair = /^\/pair\s+(.+\S)\s*$/.exec(text);
  if (pair) {
    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'pair',
      id,
      status: 'pending',
      msg: 'Pairing…',
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    post({ type: 'pair', id, payload: pair[1] });
    return true;
  }

  // Bare `/pair` (no payload) opens the QR scanner on the RN side.
  if (/^\/pair\s*$/.test(text)) {
    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'pair',
      id,
      status: 'pending',
      msg: 'Opening camera…',
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    post({ type: 'pairScan', id });
    return true;
  }

  return false;
}

const extensions = [
  history(),
  // Highest precedence Enter: intercept slash commands before the newline.
  keymap.of([{ key: 'Enter', run: aiCommandOnEnter }]),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  openLinks,
  markdown({ base: markdownLanguage, codeLanguages }),
  syntaxHighlighting(highlight),
  previewField,
  askLiveField,
  cardField,
  previewFetcher,
  codeBlocks,
  blockquotes,
  livePreview,
  theme,
  EditorView.lineWrapping,
  EditorView.updateListener.of(u => {
    if (u.docChanged) post({ type: 'change', text: u.state.doc.toString() });
  }),
];

const view = new EditorView({
  parent: document.getElementById('root'),
  state: EditorState.create({ doc: '', extensions }),
});

// RN calls this (via injectJavaScript) to seed / replace the document without
// losing the editor instance.
window.__setDoc = function (text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text ?? '' },
  });
};

// RN calls this (via injectJavaScript) once it has fetched a link's metadata;
// the card for that URL then re-renders from the loading state.
window.__setPreview = function (url, data) {
  view.dispatch({ effects: setPreviewEffect.of({ url, data }) });
};

// RN streams answer chunks here as they arrive from the server. This updates a
// live field only (no document change), so the answer grows in place without
// disturbing the caret or triggering a save on every token.
window.__aiStream = function (id, answer) {
  view.dispatch({ effects: setAskLive.of({ id, a: answer, status: 'streaming' }) });
};

// RN calls this once a run finishes (or a pairing resolves): the outcome is
// committed to the document (so it persists) and the live entry is cleared.
// `patch` merges into the marker payload, e.g. { a, status:'done' } for an
// answer or { status:'ok'|'error', msg } for pairing.
window.__aiDone = function (id, patch) {
  const found = findAiLine(view.state, id);
  const effects = [clearAskLive.of(id)];
  if (!found) {
    view.dispatch({ effects });
    return;
  }
  view.dispatch({
    changes: {
      from: found.from,
      to: found.to,
      insert: encodeAiMarker({ ...found.obj, ...patch }),
    },
    effects,
  });
};

post({ type: 'ready' });
