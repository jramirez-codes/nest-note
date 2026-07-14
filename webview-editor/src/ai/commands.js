import { encodeAiMarker, genId, serializeFull } from './marker.js';
import { post } from '../bridge.js';
import { c } from '../theme/palette.js';

// --- Slash-command autocomplete ---------------------------------------------
// A Claude-Code-style menu: type `/` at the start of a line and a dropdown of
// available commands appears. Picking one inserts the command with a trailing
// space, ready for its argument. Handling of the finished command still happens
// on Enter in aiCommandOnEnter below.
const SLASH_COMMANDS = [
  {
    label: '/agg-tasks',
    detail: 'Sweep a subject\'s whole notebook for action items and file one task card per item',
    apply: '/agg-tasks ',
  },
  {
    label: '/archive',
    detail: 'Archive this page — lifts it off the pad into the dashboard\'s Archived section, reopenable from there',
    apply: '/archive',
  },
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
    label: '/clean',
    detail: 'Clean up & reorganize the whole page — add guidance after, e.g. /clean project ideas',
    apply: '/clean ',
  },
  {
    label: '/code',
    detail: 'Start a Claude Code agent in a project on the paired laptop — chat, watch its tools run',
    apply: '/code ',
  },
  {
    label: '/delete',
    detail: 'Delete a project folder on the paired laptop — /delete PROJECT asks to confirm, then removes it',
    apply: '/delete ',
  },
  {
    label: '/ingest',
    detail: 'File this page into your dashboard — sorts notes into subjects, then clears the page',
    apply: '/ingest',
  },
  {
    label: '/pair',
    detail: 'Pair a device by QR code or payload',
    apply: '/pair ',
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
    label: '/search',
    detail: 'Search your notebooks — /search QUERY — pick a result to jump straight to that page',
    apply: '/search ',
  },
  {
    label: '/talk',
    detail: 'Chat about a subject — /talk SUBJECT <message> — the orchestrator keeps its notes updated as you talk',
    apply: '/talk ',
  },
  {
    label: '/update-server',
    detail: 'Update the paired laptop: pull the latest code, rebuild the Go server, and restart it',
    apply: '/update-server',
  },
  {
    label: '/view',
    detail: 'Preview a web page from a localhost dev server on the paired laptop — /view PORT loads http://localhost:PORT live in a card',
    apply: '/view ',
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
// `/delete <name>` targets the very same project namespace, so it reuses it too.
export const codeProjectSource = makeProjectSource('code');
export const runProjectSource = makeProjectSource('run');
export const deleteProjectSource = makeProjectSource('delete');

// --- subject autocomplete for `/talk <subject>` and `/agg-tasks <subject>` ----
// A separate list from codeProjects above: this is the orchestrator's existing
// MCP notebook slugs, not project directories. Kept in sync by RN pushing
// window.__setTalkSubjects (see index.js) with the reply to each listSubjects
// post. Starts empty; the first keystroke of either command asks for the list
// and the menu repopulates as soon as it lands. Typing a subject not in the
// list is still valid for /talk (it creates that notebook on first use); for
// /agg-tasks an unknown subject just means nothing to sweep.
let talkSubjects = [];
export function setTalkSubjects(names) {
  talkSubjects = Array.isArray(names) ? names.filter(n => typeof n === 'string') : [];
}

// Builds a completion source for `/<cmd> <subject>`, mirroring makeProjectSource
// above but reading talkSubjects and asking for a fresh listSubjects reply
// instead of listProjects.
function makeSubjectSource(cmd) {
  const re = new RegExp('^\\/ ?' + cmd + '\\s+(\\S*)$');
  return function subjectSource(context) {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const m = re.exec(before);
    if (!m) return null;
    // Ask RN to (re)send the current subject list; the reply refreshes talkSubjects
    // and re-opens the menu (see window.__setTalkSubjects). Fire-and-forget — serve
    // whatever's cached now.
    post({ type: 'listSubjects' });
    const word = m[1].toLowerCase();
    const options = talkSubjects
      .filter(name => name.toLowerCase().startsWith(word))
      .map(name => ({ label: name, type: 'text', apply: name + ' ' }));
    if (!options.length) return null;
    // Replace just the partial name (from the caret back over m[1]), leaving the
    // `/<cmd> ` prefix intact; CM's own filter is off since we prefix-matched already.
    return { from: context.pos - m[1].length, to: context.pos, options, filter: false };
  };
}

export const talkSubjectSource = makeSubjectSource('talk');
export const aggTasksSubjectSource = makeSubjectSource('agg-tasks');

// --- search autocomplete for `/search <query>` -------------------------------
// Unlike the fixed lists above (fetched once, then filtered client-side as the
// user types a prefix), a search query changes what "matches" even means — so
// every distinct query is sent to RN for a real server-side search (see
// window.__setSearchResults, populated by the reply to each `search` post),
// and whatever it returns is shown as-is. `/search` is a navigation command,
// not something that leaves content behind: picking a result deletes the whole
// `/search <query>` line and jumps straight to that page, via the same
// `openPage` message a wikilink tap sends (see links.js) — no card, no marker.
let searchQuery = '';
let searchResults = []; // [{slug, title, page_num, page_title, snippet}]
export function setSearchResults(query, results) {
  // A reply for a query the user has since typed past — drop it so a slow
  // round trip can't clobber a newer (and by now correct) result set.
  if (query !== searchQuery) return;
  searchResults = Array.isArray(results) ? results : [];
}

// The whole rest of the line after `/search ` is the query (it may contain
// spaces), so — unlike makeProjectSource/makeSubjectSource, which match a
// single bare word — this captures everything up to the caret.
const searchRe = /^\/ ?search\s+(\S.*)$/;
export function searchSource(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = searchRe.exec(before);
  if (!m) return null;
  const query = m[1];
  if (query !== searchQuery) {
    // A fresh query: ask RN to run it and clear stale matches until the reply
    // lands (see window.__setSearchResults, which re-opens the menu then).
    searchQuery = query;
    searchResults = [];
    post({ type: 'search', query });
  }
  const options = searchResults.map(r => ({
    label: r.page_title,
    detail: `${r.title} — ${r.snippet}`,
    type: 'text',
    // A function `apply` (rather than a plain string) so picking a result can
    // both clear the command line AND fire the navigation, instead of leaving
    // typed text behind for the user to deal with.
    apply(view) {
      const l = view.state.doc.lineAt(view.state.selection.main.head);
      view.dispatch({
        changes: { from: l.from, to: l.to, insert: '' },
        selection: { anchor: l.from },
      });
      // `title` matches the on-disk page filename minus ".md" (see
      // notebook.go's "#N (Title)" page grammar), the same shape NotebookScreen
      // resolves a wikilink tap's title against.
      post({ type: 'openPage', slug: r.slug, title: `#${r.page_num} (${r.page_title})` });
    },
  }));
  if (!options.length) return null;
  // Replace just the typed query (from the caret back over m[1]), leaving the
  // `/search ` prefix intact; CM's own filter is off since matching already
  // happened server-side.
  return { from: context.pos - m[1].length, to: context.pos, options, filter: false };
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

  // `/talk SUBJECT <message>`: like /chat, but pinned to one subject notebook —
  // every reply has the orchestrator's ingest_topic tool available and is told to
  // file anything worth remembering under that subject as the conversation goes,
  // creating the notebook on first use. Renders with the very same chat card.
  const talk = /^\/talk\s+(\S+)\s+(.+\S)\s*$/.exec(text);
  if (talk) {
    const id = genId();
    const subject = talk[1].toLowerCase();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'notes-chat',
      id,
      subject,
      turns: [{ q: talk[2], a: '' }],
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
    post({ type: 'notesChat', id, subject, question: talk[2] });
    return true;
  }

  // `/agg-tasks SUBJECT`: sweep that subject's whole notebook for action items and
  // file a task card for each (fire-and-forget, like /clean and /ingest — the
  // status chip updates in place with Claude's summary when it's done).
  const aggTasks = /^\/agg-tasks\s+(\S+)\s*$/.exec(text);
  if (aggTasks) {
    const id = genId();
    const subject = aggTasks[1].toLowerCase();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'agg-tasks',
      id,
      subject,
      status: 'running',
      msg: `Sweeping “${subject}” for tasks…`,
    });
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
    });
    post({ type: 'aggTasks', id, subject });
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

  // `/delete <name>`: remove a project folder on the paired laptop. This is
  // destructive, so no card is dropped and nothing is deleted here — we just
  // clear the command line and hand the intent to RN, which pops a native
  // confirmation dialog and only removes the folder once the user says yes.
  const deleteCmd = /^\/delete\s+(.+\S)\s*$/.exec(text);
  if (deleteCmd) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
    });
    post({ type: 'deleteProject', project: deleteCmd[1] });
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

  // `/update-server`: tell the paired laptop to pull the latest code, rebuild its
  // Go server, and restart into the new binary. Takes no argument. Drops a status
  // card; the actual pull/build/restart and the reconnect polling live on the RN
  // side (updateController), which commits phases back via __aiDone.
  if (/^\/update-server\s*$/.test(text)) {
    const id = genId();
    const marker = encodeAiMarker({
      v: 1,
      kind: 'update',
      id,
      status: 'running',
      msg: 'Pulling & rebuilding…',
    });
    // Trailing blank line under the card's closing `-->` so there's always a
    // clickable, typeable spot directly beneath the widget (the card decoration
    // otherwise butts straight up against whatever follows it).
    const insert = marker + '\n\n';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + marker.length + 1 },
    });
    post({ type: 'updateServer', id });
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
    // The page text to clean is the document with this command line removed, and
    // FULLY HYDRATED — card bodies live out-of-document now, so serializeFull
    // re-inlines each transcript/output/answer so Claude reorganizes the real page,
    // not one full of empty light markers.
    const pageText = serializeFull(state, { from: line.from, to: line.to }).replace(
      /^\n+|\n+$/g,
      '',
    );
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

  // `/archive`: lift the WHOLE page off the pad into the dashboard's Archived
  // section. Like `/delete` this drops no card — we strip the command line from
  // the doc, then hand the resulting page text to RN. Crucially we send the RAW
  // document (NOT serializeFull): card bodies stay in card_payloads keyed by the
  // unchanged page id, so reopening the archived page from the dashboard restores
  // every card. RN persists this text + the archived flag and removes the page
  // from the pad.
  if (/^\/archive\s*$/.test(text)) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
    });
    const pageText = view.state.doc.toString().replace(/^\n+|\n+$/g, '');
    post({ type: 'archive', pageText });
    return true;
  }

  // `/ingest`: hand the WHOLE page (minus this command line) to the orchestrator,
  // which sorts every topic into its subject server (creating one when none fits).
  // On success the RN side deletes the whole page — the notes now live in the
  // dashboard — so this card vanishes with it; on failure the page is left intact.
  const ingest = /^\/ingest\b\s*(.*)$/.exec(text);
  if (ingest) {
    // Fully hydrate the page (card bodies are stored out-of-document) so the
    // orchestrator files the real transcripts/output, not empty light markers.
    const pageText = serializeFull(state, { from: line.from, to: line.to }).replace(
      /^\n+|\n+$/g,
      '',
    );
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
