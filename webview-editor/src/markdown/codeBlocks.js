import { Decoration } from '@codemirror/view';
import { syntaxTree, StreamLanguage } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { go } from '@codemirror/lang-go';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { decoPlugin, decoRanges } from './viewPlugin.js';
import { CopyButtonWidget } from './widgets/copyButton.js';
import { c } from '../theme/palette.js';

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
  if (['py', 'python'].includes(lang)) return python().language;
  if (['go', 'golang'].includes(lang)) return go().language;
  // Bash/shell has no dedicated lang package — use the legacy stream mode.
  if (['sh', 'bash', 'shell', 'zsh'].includes(lang)) return StreamLanguage.define(shell);
  return null;
}

// The fenced code card: a Catppuccin well spanning every `cm-code-line`, rounded
// on the first/last line, with the copy button (from ui/buttons) centred on the
// fence row. (Distinct from the /code AGENT card's `.cm-code-log` transcript.)
export const styles = {
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
  // stays pinned to its top-right corner via the base rule in ui/buttons).
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
};
