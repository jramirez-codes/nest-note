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
    label: '/chat',
    detail: 'Start a conversation with Claude — reply in the card to keep the thread',
    apply: '/chat ',
  },
  {
    label: '/record',
    detail: 'Record microphone audio — keeps going in the background; tap to stop',
    apply: '/record',
  },
  {
    label: '/run',
    detail: 'Run a shell command on the paired laptop — output streams live into a terminal card',
    apply: '/run ',
  },
  {
    label: '/code',
    detail: 'Start a Claude Code agent in a project on the paired laptop — chat, watch its tools run',
    apply: '/code ',
  },
  {
    label: '/pair',
    detail: 'Pair a device by QR code or payload',
    apply: '/pair ',
  },
  {
    label: '/clean',
    detail: 'Clean up & reorganize the whole page — add guidance after, e.g. /clean project ideas',
    apply: '/clean ',
  },
  {
    label: '/ingest',
    detail: 'File this page into your dashboard — sorts notes into subjects, then clears the page',
    apply: '/ingest',
  },
];

// Only fires when the caret is on a line that is a lone `/word` (the slash at
// column 0), so slashes inside prose or URLs never pop the menu. One space right
// after the slash is tolerated (`/ ask` ≡ `/ask`): the `1`→`/` line-start
// shortcut (see lineStartReplace) leaves mobile keyboards autocorrecting the
// slash back to `1` when a letter lands on it immediately; typing a space first
// breaks that composition, so the spaced form has to trigger the menu too.
export function slashCommandSource(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = /^\/ ?(\w*)$/.exec(before);
  if (!m) return null;
  // Don't force the menu open on a bare cursor unless the user actually typed
  // the slash (bare `/` or the space-tolerant `/ `).
  if (!context.explicit && m[1] === '' && before !== '/' && before !== '/ ') return null;
  // Filter the list ourselves against the command word (`m[1]`, the part after
  // the slash and optional space) and hand CM the result with `filter: false`.
  // CM's own fuzzy filter scores against the slash-prefixed label over the whole
  // matched range — the space in a `/ a` prefix has no counterpart in any label,
  // so it would drop every option. Matching only the word, prefix-style, is both
  // correct and what a command palette should do. `from`/`to` still span the
  // full `/ …` prefix, so `apply` (the canonical `/ask `) replaces the space.
  const word = m[1].toLowerCase();
  const options = SLASH_COMMANDS.filter(cmd =>
    cmd.label.slice(1).toLowerCase().startsWith(word),
  ).map(cmd => ({ label: cmd.label, detail: cmd.detail, apply: cmd.apply }));
  if (!options.length) return null;
  return { from: line.from, to: context.pos, options, filter: false };
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
  // Tolerate one space right after the slash so `/ ask …` matches `/ask …` (see
  // slashCommandSource for why the spaced form exists). The whole line is
  // replaced by the card marker below regardless, so normalizing `text` here is
  // enough — every command regex sees the canonical `/command` form.
  const text = line.text.replace(/^\/ /, '/');

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

  // `/chat <question>`: like /ask, but the card keeps a persistent id and a
  // running transcript, so the follow-up box in the card threads replies back
  // into the same conversation (see appendChatTurn).
  const chat = /^\/chat\s+(.+\S)\s*$/.exec(text);
  if (chat) {
    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'chat',
      id,
      turns: [{ q: chat[1], a: '' }],
      open: true,
      status: 'streaming',
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    // The first turn has no prior context; runs on the same /ask stream path.
    post({ type: 'ask', id, question: chat[1] });
    return true;
  }

  // `/record [label]`: drop an audio-recorder card. It starts idle — the actual
  // capture begins only when the user taps its Record button (see recordDOM),
  // which asks for mic permission and spins up the foreground service.
  const record = /^\/record\b\s*(.*)$/.exec(text);
  if (record) {
    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'record',
      id,
      status: 'idle',
      label: record[1].trim() || undefined,
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    return true;
  }

  // `/run <cmd>`: drop a live terminal card and stream a shell command from the
  // paired laptop into it. The pinned /exec socket lives on the RN side; this only
  // creates the card and posts the intent by id. The card starts open and running.
  const runCmd = /^\/run\s+(.+\S)\s*$/.exec(text);
  if (runCmd) {
    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'run',
      id,
      cmd: runCmd[1],
      status: 'running',
      open: true,
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    post({ type: 'run', id, cmd: runCmd[1] });
    return true;
  }

  // `/code <name>`: open a persistent Claude Code agent session in projects/<name>
  // on the paired laptop (the dir is created if missing). The whole argument is
  // the project name; the first prompt is entered in the card, which threads
  // follow-ups back into the same long-lived session. Pinned /code socket lives
  // on the RN side; this only creates the card and posts the intent by id.
  const codeCmd = /^\/code\s+(.+\S)\s*$/.exec(text);
  if (codeCmd) {
    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'code',
      id,
      project: codeCmd[1],
      status: 'running',
      open: true,
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    post({ type: 'code', id, project: codeCmd[1] });
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

  // `/clean [guidance]`: hand the WHOLE page (minus this command line) to Claude
  // to rewrite. The result replaces the doc behind an Accept/Reject review bar
  // (see __cleanApply); the run itself is owned by the RN side.
  const clean = /^\/clean\b\s*(.*)$/.exec(text);
  if (clean) {
    const guidance = clean[1].trim();
    // The page text to clean is the document with this command line removed.
    const before = state.doc.sliceString(0, line.from);
    const after = state.doc.sliceString(line.to);
    const pageText = (before + after).replace(/^\n+|\n+$/g, '');
    if (!pageText.trim()) return false; // nothing to clean — let Enter be normal

    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'clean',
      id,
      status: 'streaming',
      msg: guidance ? `Cleaning up as “${guidance}”…` : 'Cleaning up your notes…',
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    post({ type: 'clean', id, pageText, guidance });
    return true;
  }

  // `/ingest`: hand the WHOLE page (minus this command line) to the orchestrator,
  // which sorts every topic into its subject server (creating one when none fits).
  // On success the RN side deletes the whole page — the notes now live in the
  // dashboard — so this card vanishes with it; on failure the page is left intact.
  const ingest = /^\/ingest\b\s*(.*)$/.exec(text);
  if (ingest) {
    const before = state.doc.sliceString(0, line.from);
    const after = state.doc.sliceString(line.to);
    const pageText = (before + after).replace(/^\n+|\n+$/g, '');
    if (!pageText.trim()) return false; // nothing to ingest — let Enter be normal

    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'ingest',
      id,
      status: 'streaming',
      msg: 'Sorting into your dashboard…',
    });
    const insert = marker + '\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    post({ type: 'ingest', id, pageText });
    return true;
  }

  return false;
}
