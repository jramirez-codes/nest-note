/**
 * The assistant's streaming runs: /ask (and its /chat follow-ups), /clean, and
 * /ingest. Each frames the user's request as a prompt, streams it through Claude
 * on the paired server via ./client's `run`, and adapts the token stream to the
 * simple callback shape the editor cards expect.
 *
 * /clean and /ingest are thin wrappers over {@link runAsk} — they only differ in
 * how they build the prompt and parse the final text — so the proven streaming,
 * reconnect, and cancellation logic is written once.
 */

import { run, type RunHandle, type SessionOpts } from '../transport/client';
import { getTransport, currentServer, NO_MODULE } from '../transport/connection';
import { setServerStatus } from '../transport/status';

export interface AskCallbacks {
  /** Called with the full answer-so-far on every streamed chunk. */
  onDelta: (answer: string) => void;
  /** Called once with the final answer text when the run completes cleanly. */
  onDone: (answer: string) => void;
  /** Called on failure, with any partial answer streamed before the error. */
  onError: (msg: string, partial: string) => void;
}

export interface AskHandle {
  cancel(): void;
}

/**
 * Context threaded into a follow-up so a fresh run answers in-conversation.
 * `turns` carries a whole /chat transcript (each `{ q, a }` an earlier exchange);
 * `q`/`a` is the single-turn form still accepted for one-off follow-ups.
 */
export interface AskContext {
  q?: string;
  a?: string;
  turns?: { q?: string; a?: string }[];
}

// Each run is a fresh `claude -p` (no server-side session), so a follow-up must
// carry its own context: fold the prior exchange(s) into the prompt Claude
// receives. The card still shows only the raw follow-up question.
function buildPrompt(question: string, context?: AskContext): string {
  const turns = context?.turns?.filter(t => t.q);
  if (turns && turns.length) {
    const history = turns
      .map(t => `User: ${t.q}\n\nAssistant: ${t.a || ''}`)
      .join('\n\n');
    return (
      `You are continuing a conversation. Here is the conversation so far:\n\n` +
      `${history}\n\n` +
      `Now answer this follow-up:\n\n${question}`
    );
  }
  if (!context || !context.q) return question;
  return (
    `You are continuing a conversation. Earlier you were asked:\n\n${context.q}\n\n` +
    (context.a ? `You answered:\n\n${context.a}\n\n` : '') +
    `Now answer this follow-up:\n\n${question}`
  );
}

/**
 * Stream an answer for `question`. Returns immediately; callbacks fire as the
 * answer arrives. Cancelling stops the underlying run (which disconnects the
 * socket, killing the server-side Claude process). `context`, when present,
 * threads a prior card's Q&A into the prompt so follow-ups stay in-conversation.
 */
export function runAsk(
  question: string,
  cb: AskCallbacks,
  session: SessionOpts,
  context?: AskContext,
): AskHandle {
  let cancelled = false;
  let handle: RunHandle | null = null;
  // `answer` holds committed turns; `streaming` holds the live token buffer for
  // the turn currently arriving. Deltas grow `streaming`; the turn's closing
  // full-text snapshot commits into `answer` and resets `streaming`, so the two
  // sources never double-count. onDone/onError report `answer` (+ any tail).
  let answer = '';
  let streaming = '';

  // On a reconnect the server replays the whole answer, so clear our local
  // accumulation first (then let the registry clear its buffer + the webview live
  // field) — otherwise the replayed text would double the committed answer.
  const reconnectSession: SessionOpts = {
    ...session,
    onReset: () => {
      answer = '';
      streaming = '';
      session.onReset?.();
    },
  };

  (async () => {
    const t = getTransport();
    if (!t) {
      cb.onError(NO_MODULE, '');
      return;
    }
    const server = await currentServer();
    if (!server) {
      cb.onError('Not connected. Pair first with “/pair <payload>”.', '');
      return;
    }
    if (cancelled) return;

    handle = run(
      t,
      server,
      server.token,
      buildPrompt(question, context),
      ev => {
        // Any event off the socket proves the server is live right now.
        setServerStatus('connected');
        if (ev.kind === 'assistant-delta') {
          // A freshly generated token: grow the live buffer and show it typing out.
          streaming += ev.text;
          cb.onDelta(answer + streaming);
        } else if (ev.kind === 'assistant-text') {
          // The turn's authoritative full text landed; commit it and drop the
          // delta buffer that built it so the answer doesn't double. (When the CLI
          // isn't streaming partials, this is the only event and still works.)
          answer += ev.text;
          streaming = '';
          cb.onDelta(answer);
        }
      },
      reconnectSession,
    );

    try {
      const res = await handle.done;
      if (cancelled) return;
      const partial = answer + streaming;
      if (res.isError) cb.onError(res.result || 'The run failed.', partial);
      else cb.onDone(partial || res.result);
    } catch (e) {
      if (cancelled) return;
      // The run never reached (or lost) the server — reflect that in the bubble.
      setServerStatus('disconnected');
      cb.onError(e instanceof Error ? e.message : String(e), answer + streaming);
    }
  })();

  return {
    cancel() {
      cancelled = true;
      handle?.cancel();
    },
  };
}

export interface CleanCallbacks {
  /**
   * Called once when the run completes cleanly with the cleaned page text and,
   * when a title was requested and produced, a short generated title ('' if none).
   */
  onDone: (cleaned: string, title: string) => void;
  /** Called on failure with a message; the original page text is left untouched. */
  onError: (msg: string) => void;
}

// Frame the page as a rewrite task. `guidance` (from `/clean project ideas`)
// steers how the notes get organized; empty means "just tidy them up". When
// `needTitle`, the reply is prefixed with a `TITLE:` line we parse back out.
function buildCleanPrompt(pageText: string, guidance: string, needTitle: boolean): string {
  const g = guidance.trim();
  const titleLine = needTitle
    ? 'Start your reply with a single line of the form `TITLE: <title>`, where ' +
      '<title> is a short 3–6 word plain-text title for these notes (no markdown, ' +
      'no quotes). Follow it with one blank line, then the cleaned notes.\n\n'
    : 'Return only the cleaned notes.\n\n';
  return (
    'You are a note-cleaning assistant. Rewrite the notes below into a cleaner, ' +
    'better-organized version. Preserve every piece of information and its meaning; ' +
    'fix grammar, spelling and structure; use Markdown headings, lists and task ' +
    'checkboxes where they make the notes clearer. Do not invent facts or add ' +
    'commentary.' +
    (g ? ` Organize the notes around: ${g}.` : '') +
    '\n\n' +
    titleLine +
    'Do not wrap your output in a code fence.\n\n<notes>\n' +
    pageText +
    '\n</notes>'
  );
}

// Claude occasionally wraps the whole reply in a ``` fence despite the prompt;
// unwrap a fence that spans the entire answer so it doesn't land in the note.
function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

// Tidy a raw title line into a plain, single-line, unquoted, capped title.
function cleanTitle(raw: string): string {
  let t = raw.replace(/[\r\n]+/g, ' ').trim();
  t = t.replace(/^#+\s*/, ''); // stray heading marker
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim(); // surrounding quotes
  return t.length > 60 ? t.slice(0, 60).trim() : t;
}

// Split off a leading `TITLE: …` line if present. Always stripped (even when a
// title wasn't requested) so a stray one can never leak into the note body.
function splitTitle(text: string): { title: string; body: string } {
  // Title is the rest of the first line; body is everything after it (possibly
  // empty — a title-only reply then yields no notes and is treated as a failure).
  const m = /^﻿?[ \t]*TITLE:[ \t]*([^\r\n]*)([\s\S]*)$/.exec(text);
  return m ? { title: cleanTitle(m[1]), body: m[2] } : { title: '', body: text };
}

/**
 * Rewrite `pageText` into a cleaned-up version, streamed on the same proven path
 * as {@link runAsk}. The card shows a spinner (not the stream), so only the
 * final text matters: it's handed to onDone once and the editor swaps it in
 * behind an Accept/Reject bar. When `needTitle`, the same call also produces a
 * short title (the page has none yet). Cancelling tears down the underlying run.
 */
export function runClean(
  pageText: string,
  guidance: string,
  needTitle: boolean,
  cb: CleanCallbacks,
  session: SessionOpts,
): AskHandle {
  return runAsk(
    buildCleanPrompt(pageText, guidance, needTitle),
    {
      onDelta: () => {},
      onDone: answer => {
        const { title, body } = splitTitle(answer.trim());
        const cleaned = stripFence(body);
        // An empty rewrite would blank the note — treat it as a failure so the
        // original page text is left untouched.
        if (cleaned) cb.onDone(cleaned, needTitle ? title : '');
        else cb.onError('Cleanup returned nothing.');
      },
      // Leave the page as-is on failure; the card shows the error, notes are safe.
      onError: msg => cb.onError(msg),
    },
    session,
  );
}

// Frame the page as an ongoing, subject-scoped conversation for the orchestrator
// MCP: unlike /ingest (one whole page, one shot), /talk pins every turn to a
// single known subject and asks Claude to keep that subject's notebook current
// as the conversation goes, via ingest_topic (which creates the notebook on
// first use — the subject need not exist yet). It's also told, explicitly, how
// to reorganize what's already there when asked — this doesn't just ride on the
// server's ambient "rewrite when messy" heuristic (that's a quiet, incidental
// trigger, not a guaranteed response to a direct request). Conversation history
// is folded in exactly like buildPrompt's /chat continuation.
function buildTalkPrompt(subject: string, question: string, context?: AskContext): string {
  const instructions =
    `You are having an ongoing conversation with the user about the subject "${subject}", ` +
    'tracked by a personal-knowledge-base MCP server (the orchestrator). Reply to the user ' +
    'conversationally. Whenever they share information, facts, updates, or decisions worth ' +
    `remembering about ${subject}, call the orchestrator's ingest_topic tool with ` +
    `subject="${subject}" to file it (it creates the notebook on first use if none exists yet). ` +
    'Keep this invisible to the user except a brief, natural mention when you file something. ' +
    'Do not file trivial chit-chat — only real content.\n\n' +
    `If the user says they don't like how the existing "${subject}" notes are organized or ` +
    'formatted, or asks you to clean them up, restructure them, or make them more digestible: ' +
    `call ${subject}_notes to read the whole current notebook, then call ${subject}_rewrite with ` +
    'a rewritten markdown body. Reorganize freely — regroup related facts under clear headings, ' +
    'convert action items into `- [ ]` task checkboxes (`- [x]` for ones already done), turn ' +
    'loose prose into lists where that reads better, fix grammar, and remove duplication. Preserve ' +
    'every fact and its meaning — never invent or drop information. Briefly tell the user what you ' +
    `changed. (${subject}_notes/${subject}_rewrite only exist once this subject's notebook has ` +
    "been created — if they aren't available yet, say so instead of trying.)\n\n" +
    `This subject's dashboard tasks are also yours to manage here, live, as the user asks: ` +
    `call the orchestrator's list_cards with source="${subject}" to see what already exists ` +
    'before creating or changing anything. To add a task, call upsert_card with kind="task", ' +
    `source="${subject}", an honest priority (urgent | high | normal | low), and a date if one ` +
    'was mentioned. To edit one (retitle, reschedule, reprioritize), call upsert_card again with ' +
    'that same card\'s id. To mark one done or reopen it, call upsert_card with that id and ' +
    'done=true/false. To remove one entirely (the user says delete/drop/cancel it), call ' +
    'dismiss_card with its id. Do this quietly and confirm briefly in your reply — do not ask ' +
    'the user to go to the dashboard to make a change they already asked you for in words.\n\n';
  const turns = context?.turns?.filter(t => t.q);
  if (turns && turns.length) {
    const history = turns.map(t => `User: ${t.q}\n\nAssistant: ${t.a || ''}`).join('\n\n');
    return instructions + `Conversation so far:\n\n${history}\n\nNow reply to:\n\n${question}`;
  }
  return instructions + question;
}

/**
 * Stream a /talk reply for `subject`. Runs on the same proven stream path as
 * {@link runAsk} (reconnect, cancellation, delta/done handling) but the prompt
 * keeps the orchestrator's ingest_topic tool pointed at one fixed subject the
 * whole thread, so the notebook stays current turn by turn instead of at the end.
 */
export function runNotesChat(
  subject: string,
  question: string,
  cb: AskCallbacks,
  session: SessionOpts,
  context?: AskContext,
): AskHandle {
  return runAsk(buildTalkPrompt(subject, question, context), cb, session);
}

export interface IngestCallbacks {
  /** The run finished cleanly; `summary` is Claude's one-line report of what it filed. */
  onDone: (summary: string) => void;
  /** The run failed; the page must be left intact and the error shown. */
  onError: (msg: string) => void;
}

// Frame the page as a sorting task for the orchestrator MCP. Claude reads the
// existing subject servers, groups the page by topic, and files each group with
// `ingest_topic` (which creates a subject's notes store on first use). The server
// always appends its own orchestration routine, so this only has to describe the
// ingest job. We deliberately forbid questions: /ingest is fire-and-forget, and
// any genuine ambiguity becomes an optional `suggest_merge` the dashboard surfaces.
function buildIngestPrompt(pageText: string): string {
  return (
    'You are sorting a page of notes into a personal knowledge base made of ' +
    'per-subject "notes servers", managed by the orchestrator MCP.\n\n' +
    'Do exactly this, without asking the user anything:\n' +
    '1. Call list_capabilities to see which subject servers already exist.\n' +
    '2. Group the notes below by subject/topic. Reuse an existing subject slug ' +
    'whenever a note fits one; otherwise choose a short lowercase slug for a new ' +
    'subject.\n' +
    '3. For each subject, call ingest_topic(subject, summary, notes) with that ' +
    "subject's notes (lightly cleaned for grammar). Preserve every fact; invent " +
    'nothing; file every note into exactly one subject.\n' +
    '   • Any block that starts with a line "<!--ai" and ends with a line "-->" is ' +
    'a rendered widget (e.g. a voice recording), NOT prose. Copy each such block ' +
    'through VERBATIM — byte for byte, every line between "<!--" and "-->" ' +
    'unchanged, including its "file:" path — into the notes of whichever subject it ' +
    'belongs with. Never edit, reword, reformat, translate, summarize, split, or ' +
    'drop anything inside an HTML comment, and keep the whole block intact on its ' +
    'own lines.\n' +
    '4. Only if two EXISTING subjects clearly duplicate each other may you call ' +
    'suggest_merge. Never merge on your own.\n' +
    '5. Also surface anything actionable as a dashboard card (call list_cards first ' +
    'to avoid duplicates): use upsert_card with kind="task" for things the user ' +
    'needs to do, attaching a date when a due date is stated. Set priority ' +
    '(urgent | high | normal | low) as an honest urgency judgment, and set source to ' +
    'the subject slug the card came from. Only make cards for genuine tasks — not ' +
    'for every note.\n\n' +
    'When finished, reply with a single short line summarizing what you filed and ' +
    'where. Do not ask questions.\n\n<notes>\n' +
    pageText +
    '\n</notes>'
  );
}

/**
 * Sort `pageText` into the orchestrator's subject servers. Runs on the same proven
 * stream path as {@link runAsk} but only cares about completion: on success the
 * caller deletes the page (the notes now live in the dashboard); on failure the
 * page is left untouched. Cancelling tears down the underlying run.
 */
export function runIngest(pageText: string, cb: IngestCallbacks, session: SessionOpts): AskHandle {
  return runAsk(
    buildIngestPrompt(pageText),
    {
      onDelta: () => {},
      onDone: answer => cb.onDone(answer.trim()),
      onError: msg => cb.onError(msg),
    },
    session,
  );
}

// Frame a whole subject notebook as a task-sweep for the orchestrator MCP: read
// every page of `${subject}_notes`, cross-reference the subject's existing cards,
// and file (or update) a task card for every action item found across the whole
// notebook — not just its newest page, unlike /talk's turn-by-turn filing. This is
// /agg-tasks's entire job, so it's the only thing the prompt describes.
function buildAggTasksPrompt(subject: string): string {
  return (
    `You are sweeping the "${subject}" notebook (a personal-knowledge-base subject ` +
    'tracked by the orchestrator MCP) for action items, without asking the user anything.\n\n' +
    'Do exactly this:\n' +
    `1. Call ${subject}_notes to read the whole notebook. If that tool does not exist, ` +
    `there is no "${subject}" notebook yet — reply saying so and stop.\n` +
    `2. Call the orchestrator's list_cards with source="${subject}" to see which tasks ` +
    'are already filed for this subject.\n' +
    '3. Read every page and pull out every action item, commitment, or thing the user ' +
    'still needs to do — across the whole notebook, not just the most recent page. ' +
    'For each one, call upsert_card with kind="task", ' +
    `source="${subject}", an honest priority (urgent | high | normal | low), and a date ` +
    'when one is stated or clearly implied.\n' +
    '4. Match against the existing cards from step 2 by meaning, not exact wording: if a ' +
    'task is already filed, call upsert_card with that same card\'s id so it updates in ' +
    'place instead of duplicating (and leave its done state alone by omitting `done`). ' +
    'Only create a new card for a genuinely new action item.\n' +
    '5. Do not invent tasks that are not actually in the notes, and do not file ' +
    'informational notes as tasks.\n\n' +
    'When finished, reply with a single short line: how many tasks were filed as new vs. ' +
    'already up to date. Do not ask questions.'
  );
}

export interface AggTasksCallbacks {
  /** The sweep finished cleanly; `summary` is Claude's one-line report. */
  onDone: (summary: string) => void;
  /** The sweep failed; nothing was necessarily written, and the error is shown. */
  onError: (msg: string) => void;
}

/**
 * Sweep `subject`'s whole notebook for action items and file/update a task card for
 * each (see {@link buildAggTasksPrompt}). Runs on the same proven stream path as
 * {@link runAsk} but only cares about the final one-line summary. Cancelling tears
 * down the underlying run.
 */
export function runAggTasks(
  subject: string,
  cb: AggTasksCallbacks,
  session: SessionOpts,
): AskHandle {
  return runAsk(
    buildAggTasksPrompt(subject),
    {
      onDelta: () => {},
      onDone: answer => cb.onDone(answer.trim() || 'Done — nothing to report.'),
      onError: msg => cb.onError(msg),
    },
    session,
  );
}
