import { encodeAiMarker, genId } from './marker.js';
import { post } from '../bridge.js';
import { c } from '../theme/palette.js';

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
    detail: 'Run a shell command inside a project on the paired laptop — /run PROJECT <cmd>; output streams live into a terminal card',
    apply: '/run ',
  },
  {
    label: '/code',
    detail: 'Start a Claude Code agent in a project on the paired laptop — chat, watch its tools run',
    apply: '/code ',
  },
  {
    label: '/view',
    detail: 'Preview a web page from a localhost dev server on the paired laptop — /view PORT loads http://localhost:PORT live in a card',
    apply: '/view ',
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

// --- project autocomplete for `/code <name>` and `/run <name>` ---------------
// Both commands take a project folder as their first argument (see aiCommandOnEnter),
// so they share one directory listing and one completion source. The list is the
// project dirs the paired laptop reported, kept in sync by RN pushing
// window.__setProjects (see editor.js) with the reply to each listProjects post.
// Starts empty; the first `/code `/`/run ` keystroke asks for the list and the
// menu repopulates as soon as it lands.
let codeProjects = [];
export function setCodeProjects(names) {
  codeProjects = Array.isArray(names) ? names.filter(n => typeof n === 'string') : [];
}

// Build a completion source that autocompletes the project name right after
// `/<cmd> ` (space-tolerant slash, per slashCommandSource). Reads the laptop's
// directory listing (setCodeProjects) and offers it prefix-filtered by what's
// typed so far; picking one inserts `<name> `, ready for the first prompt (/code)
// or the command (/run). Distinct from slashCommandSource, which only fires
// before the command's trailing space — once that space is typed this source
// takes over the same line, and a second word (the prompt/command starting) stops
// matching and closes the menu.
function makeProjectSource(cmd) {
  const re = new RegExp('^\\/ ?' + cmd + '\\s+(\\S*)$');
  return function projectSource(context) {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const m = re.exec(before);
    if (!m) return null;
    // Ask RN to (re)send the current listing; the reply refreshes codeProjects and
    // re-opens the menu (see window.__setProjects). Fire-and-forget — serve cache now.
    post({ type: 'listProjects' });
    const word = m[1].toLowerCase();
    const options = codeProjects
      .filter(name => name.toLowerCase().startsWith(word))
      .map(name => ({ label: name, type: 'text', apply: name + ' ' }));
    if (!options.length) return null;
    // Replace just the partial name (from the caret back over m[1]), leaving the
    // `/<cmd> ` prefix intact; CM's own filter is off since we prefix-matched already.
    return { from: context.pos - m[1].length, to: context.pos, options, filter: false };
  };
}

// `/code <name>` and `/run <name>` both pick a project folder the same way — in
// the -root deployment where both are enabled the exec base and the projects base
// are the same folder, so a listed name is a real dir either command can target.
export const codeProjectSource = makeProjectSource('code');
export const runProjectSource = makeProjectSource('run');

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
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
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
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
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
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
    });
    return true;
  }

  // `/run PROJECT <cmd>`: drop a live terminal card and stream a shell command
  // from the paired laptop into it, started inside project folder PROJECT (mirrors
  // `/code`'s project-first shape — the server confines it to a relative subpath
  // of the workdir). The first whitespace-delimited token is the project; the rest
  // is the command. The pinned /exec socket lives on the RN side; this only creates
  // the card and posts the intent by id. The card starts open and running.
  const runCmd = /^\/run\s+(\S+)\s+(.+\S)\s*$/.exec(text);
  if (runCmd) {
    const id = genId();
    const dir = runCmd[1];
    const cmd = runCmd[2];
    const marker = encodeAiMarker({
      v: 1,
      kind: 'run',
      id,
      cmd,
      dir,
      status: 'running',
      open: true,
    });
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
    });
    post({ type: 'run', id, cmd, dir });
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
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
    });
    post({ type: 'code', id, project: codeCmd[1] });
    return true;
  }

  // `/view PORT`: mirror a web page served by a localhost dev server on the
  // paired laptop into an iframe card. The marker persists only the port; the
  // card fetches its (token-bearing, transient) proxy URL from RN on every mount
  // — see the viewFetcher plugin — so nothing secret is written into the note.
  const viewCmd = /^\/view\s+(\d{1,5})\s*$/.exec(text);
  if (viewCmd) {
    const id = genId();
    const port = Number(viewCmd[1]);
    const marker = encodeAiMarker({
      v: 1,
      kind: 'view',
      id,
      port,
      status: 'loading',
      open: true,
    });
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
    });
    post({ type: 'view', id, port });
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
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
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
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
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
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
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
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
    });
    post({ type: 'ingest', id, pageText });
    return true;
  }

  return false;
}

// The slash-command menu (CM's autocomplete tooltip, restyled). Each row stacks
// the command name over a wrapping description, so the menu sizes to its content
// instead of cropping the detail text.
export const styles = {
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
