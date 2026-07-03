import { Decoration } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { decoPlugin } from './viewPlugin.js';
import { ImageWidget, CheckboxWidget, BulletWidget } from './widgets.js';
import { imageAlt } from './urls.js';

const HIDE = Decoration.replace({});
// Marks a run of text as a tappable link; the URL rides along as a data attr so
// the mousedown handler can hand it to RN (see openLinks / NoteEditorWebView).
function linkDeco(url) {
  return Decoration.mark({ class: 'cm-link', attributes: { 'data-url': url } });
}

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
  // Every line touched by a selection stays "revealed" (raw text shown) so it
  // can be edited. Read-only views (the /ask answer preview) never reveal — the
  // whole answer stays rendered.
  const activeLines = new Set();
  if (!state.readOnly) {
    for (const r of state.selection.ranges) {
      const first = state.doc.lineAt(r.from).number;
      const last = state.doc.lineAt(r.to).number;
      for (let n = first; n <= last; n++) activeLines.add(n);
    }
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
          if (line.text.trim() === raw) return false; // solo — a block card owns it
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

export const livePreview = decoPlugin(buildLivePreview, { selection: true });
