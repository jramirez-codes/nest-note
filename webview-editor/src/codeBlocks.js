import { Decoration } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { decoPlugin, decoRanges } from './viewPlugin.js';
import { CopyButtonWidget } from './widgets.js';

/**
 * Fenced code "cards": a Catppuccin background spanning every line of a
 * ```-block, rounded on the first/last line, with a copy button on the first.
 */
function buildCodeBlocks(view) {
  const { state } = view;
  const marks = [];
  for (const { from, to } of decoRanges(view)) {
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

export const codeBlocks = decoPlugin(buildCodeBlocks);

// Highlight code fenced with a language we bundle a parser for.
export function codeLanguages(info) {
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
