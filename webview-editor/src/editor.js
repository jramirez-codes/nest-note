import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
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
    const btn = document.createElement('span');
    btn.className = 'cm-copy-btn';
    btn.textContent = 'Copy';
    const code = this.code;
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      copyText(code);
      btn.textContent = 'Copied';
      btn.classList.add('cm-copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('cm-copied');
      }, 1200);
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

const HIDE = Decoration.replace({});
// Lezer node names for the punctuation we hide (inline emphasis/code/strike and
// the leading `#` of headings). List bullets and quote bars are left visible.
const SYNTAX_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
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
        // Also swallow the space after a heading's `#` so text isn't inset.
        if (node.name === 'HeaderMark' && state.doc.sliceString(end, end + 1) === ' ') {
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

const extensions = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  markdown({ base: markdownLanguage, codeLanguages }),
  syntaxHighlighting(highlight),
  codeBlocks,
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

post({ type: 'ready' });
