import { encodeAiMarker, genId } from './aiMarker.js';
import { post } from './bridge.js';

// --- Slash-command autocomplete ---------------------------------------------
// A Claude-Code-style menu: type `/` at the start of a line and a dropdown of
// available commands appears. Picking one inserts the command with a trailing
// space, ready for its argument. Handling of the finished command still happens
// on Enter in aiCommandOnEnter below.
const SLASH_COMMANDS = [
  {
    label: '/ask',
    detail: 'Ask Claude a question — the answer streams into a card',
    apply: '/ask ',
  },
  {
    label: '/pair',
    detail: 'Pair a device by QR code or payload',
    apply: '/pair ',
  },
];

// Only fires when the caret is on a line that is a lone `/word` (the slash at
// column 0), so slashes inside prose or URLs never pop the menu.
export function slashCommandSource(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = /^\/(\w*)$/.exec(before);
  if (!m) return null;
  // Don't force the menu open on a bare cursor unless the user actually typed.
  if (!context.explicit && m[1] === '' && before !== '/') return null;
  return {
    from: line.from,
    options: SLASH_COMMANDS.map(cmd => ({
      label: cmd.label,
      detail: cmd.detail,
      apply: cmd.apply,
    })),
    validFor: /^\/\w*$/,
  };
}

// Enter on a `/ask <question>` or `/pair <payload>` line turns that line into a
// card and hands the work to RN. Returns true to swallow the newline when it
// fires; otherwise Enter behaves normally.
export function aiCommandOnEnter(view) {
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
