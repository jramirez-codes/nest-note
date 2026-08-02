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

// Prepended to every /ask + /chat run so a plain chat doubles as a brainstorming
// surface: Claude answers normally, but when the user wants an idea kept it files
// one as a dashboard idea card (the orchestrator MCP is always attached server-side,
// so upsert_card is available). Deliberately conservative — it captures on an
// explicit "save this"/"add as an idea" or a clearly-settled keeper, NOT on ordinary
// questions — so a normal chat never litters the dashboard with cards.
const IDEA_CAPTURE =
  'You are chatting with the user — often to think out loud and brainstorm. Answer ' +
  'normally and conversationally. When the user asks you to save, keep, capture, or ' +
  '"add as an idea" something from the conversation — or clearly settles on an idea ' +
  "worth keeping — file it on their dashboard by calling the orchestrator's upsert_card " +
  'tool with kind="idea": a short title, an honest priority (urgent | high | normal | ' +
  'low), 1–4 short lowercase tags for filtering (e.g. ux, sync, ai), and a Markdown ' +
  'body with the sections "## Problem", "## Idea", "## Project plan", and "## Next ' +
  "steps\" filled in from what you discussed (leave a section empty when it wasn't " +
  'covered). If the chat is clearly about one subject, set source to its lowercase ' +
  'slug. Reuse the same card id to refine an idea instead of duplicating it. Do NOT ' +
  'file cards for ordinary questions — only when an idea is worth keeping — and confirm ' +
  'in one short line when you do.\n\n';

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
      IDEA_CAPTURE +
      `You are continuing a conversation. Here is the conversation so far:\n\n` +
      `${history}\n\n` +
      `Now answer this follow-up:\n\n${question}`
    );
  }
  if (!context || !context.q) return IDEA_CAPTURE + question;
  return (
    IDEA_CAPTURE +
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
    `To read what's already filed, call ${subject}_notes (it returns every page, the Appendix ` +
    `first). Note: ${subject}_notes/${subject}_rewrite/propose_reorg only exist once this ` +
    "subject's notebook has been created — if they aren't available yet, say so instead of " +
    'trying.\n\n' +
    `Tidying a SINGLE page in place (fix grammar, tighten wording, dedupe within that one page): ` +
    `read ${subject}_notes first, then call ${subject}_rewrite with the page's number or title ` +
    'and its rewritten markdown. Preserve every fact — never invent or drop information — and ' +
    'briefly say what you changed.\n\n' +
    `Reorganizing the notebook's STRUCTURE is different and must be the user's to confirm, so do ` +
    `NOT apply it yourself with ${subject}_rewrite. This covers combining, splitting, deleting, or ` +
    `reordering pages, or any general "clean up / restructure the whole ${subject} notebook" ` +
    'request. Instead:\n' +
    `1. Call ${subject}_notes to read every page, INCLUDING the "Task Log" pages.\n` +
    '2. The Task Log pages ("Task Log", "Task Log 2", … — the highest-numbered is the most ' +
    'recent) are a live record of tasks already completed or dropped. Cross-reference them and ' +
    'REMOVE from the content pages any item the Task Log shows is already done (e.g. a bug or ' +
    'tweak still listed as "to fix" that the log records as Completed).\n' +
    '3. Build the FULL intended set of content pages and call propose_reorg with ' +
    `subject="${subject}", a one-line summary, and those pages (each {title, body}, in order). ` +
    'Preserve every real fact; invent nothing.\n' +
    '4. NEVER include, edit, delete, or reorder a Task Log page — it is a live database the ' +
    'system preserves untouched. Do not put Task Log content in your proposed pages.\n' +
    '5. Tell the user the reorganization is queued for them to confirm on the dashboard — you ' +
    'have not changed anything yet.\n\n' +
    `This subject's dashboard tasks are also yours to manage here, live, as the user asks: ` +
    `call the orchestrator's list_cards with source="${subject}" to see what already exists ` +
    'before creating or changing anything. To add a task, call upsert_card with kind="task", ' +
    `source="${subject}", an honest priority (urgent | high | normal | low), and a date if one ` +
    'was mentioned. To edit one (retitle, reschedule, reprioritize), call upsert_card again with ' +
    'that same card\'s id. To mark one done or reopen it, call upsert_card with that id and ' +
    'done=true/false. To remove one entirely (the user says delete/drop/cancel it), call ' +
    'dismiss_card with its id. Do this quietly and confirm briefly in your reply — do not ask ' +
    'the user to go to the dashboard to make a change they already asked you for in words.\n\n' +
    'Ideas work the same way: when the user shares a genuine idea, proposal, or feature worth ' +
    `keeping about ${subject} (a thought to revisit, not an action item), file it with ` +
    'upsert_card kind="idea", structuring the body as Markdown with the sections "## Problem", ' +
    '"## Idea", "## Project plan", and "## Next steps" (fill in what was said, leave a section ' +
    'empty when it wasn\'t covered), attaching 1–4 short lowercase tags for filtering and an ' +
    'honest priority. Confirm briefly, and reuse a card id to update an idea rather than ' +
    'duplicating it.\n\n';
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

/**
 * The idea card a {@link runIdeaChat} turn is about — everything the prompt needs
 * to talk about it and to write back to the same card (its `id` is what makes an
 * edit an update rather than a duplicate).
 */
export interface IdeaRef {
  id: string;
  title: string;
  priority?: string;
  tags?: string[];
  /** The subject notebook the card belongs to, when it has one. */
  source?: string;
  /** The card's current Markdown body (the four-section idea template). */
  body?: string;
}

// Frame one idea card as the whole subject of the conversation. Unlike /chat
// (open-ended) or /talk (pinned to a notebook), this is pinned to a single card:
// the model discusses it with the user and writes changes back to that exact card
// with upsert_card, so the page under the chat updates in place. The reply lands
// in a small card in the page header, so it's asked to stay short, to never echo
// the rewritten body — the page already shows it — and to mark the reply up: the
// card renders Markdown through ChatMarkdown, where bold reads heavy and inline
// code reads green and monospaced, which is what makes a few sentences in a small
// card scannable (rule 2).
//
// It's also asked to be decisive about writing rather than to negotiate first,
// because the page can undo any edit it makes in one tap (see ../ideaChat): a
// rewrite that lands wrong costs the user a tap, while a question they have to
// answer costs them a whole turn. That asymmetry is the reason for rules 3 and 4.
function buildIdeaPrompt(idea: IdeaRef, question: string, context?: AskContext): string {
  const tags = (idea.tags ?? []).join(', ');
  const instructions =
    'You are helping the user refine ONE idea of theirs, filed as an idea card on their ' +
    'dashboard and managed by the orchestrator MCP. They have the idea open as a page and are ' +
    'talking to you about it. Work with them on tweaks and, over the conversation, toward a ' +
    'concrete project plan.\n\n' +
    'The card:\n' +
    `- id: ${idea.id}\n` +
    `- title: ${idea.title}\n` +
    `- priority: ${idea.priority || 'normal'}\n` +
    `- tags: ${tags || '(none)'}\n` +
    `- subject: ${idea.source || '(none)'}\n\n` +
    `Its current body:\n\n<idea>\n${idea.body ?? ''}\n</idea>\n\n` +
    'How to work:\n' +
    '1. Reply conversationally and BRIEFLY. Your reply is shown in a small card at the top of ' +
    "the idea's page — a few sentences, or a short list. Never paste the rewritten card body " +
    'into your reply; the page below it already shows the card.\n' +
    '2. Mark the reply up in Markdown — the card renders it, so use it. Put **bold** on what ' +
    'changed and on the decision you need from the user, and `inline code` on every concrete ' +
    'literal you name: a section like `## Next steps`, a filename, a flag, an identifier, a ' +
    'command. Inline code renders green and monospaced and bold renders heavy, so a handful of ' +
    'marks makes a few sentences scannable at a glance. Do not decorate for its own sake: never ' +
    "bold a whole sentence, and never mark up something that isn't a real literal.\n" +
    '3. DEFAULT TO WRITING, NOT ASKING. The user can undo any change you make to this card with ' +
    'one tap, so a rewrite that lands wrong is cheap for them and a question they have to answer ' +
    'is not. On every turn where the conversation gives you anything to act on, write your best ' +
    'current version of the idea into the card instead of describing what you would change and ' +
    'waiting for permission. Never ask "shall I update the card?" — update it, then say what you ' +
    'changed.\n' +
    '4. Still ask when a decision is genuinely the user\'s and you cannot make a defensible call ' +
    '(scope, a real fork between two approaches, what matters most) — but write your best guess ' +
    'into the card FIRST and ask the question about what you wrote. One question at a time, and ' +
    'make it easy to answer.\n' +
    "5. To write, call the orchestrator's upsert_card " +
    `with id="${idea.id}", kind="idea"` +
    (idea.source ? `, source="${idea.source}"` : '') +
    ', and the FULL updated Markdown body, keeping the sections "## Problem", "## Idea", ' +
    '"## Project plan", and "## Next steps". Being decisive means rewriting what the conversation ' +
    'touched — not discarding sections it never mentioned, which must be preserved as they are. ' +
    'Update the title, tags (1–4 short lowercase), and priority too when the user\'s steer ' +
    'implies it.\n' +
    `6. NEVER file a second card for this idea — always reuse id="${idea.id}". Do not create ` +
    'task cards unless the user asks for them.\n' +
    '7. As the plan firms up, fill "## Project plan" with concrete steps and "## Next steps" ' +
    'with the immediate ones. Whenever you write to the card, say in one short line what you ' +
    'changed.\n\n';
  const turns = context?.turns?.filter(t => t.q);
  if (turns && turns.length) {
    const history = turns.map(t => `User: ${t.q}\n\nAssistant: ${t.a || ''}`).join('\n\n');
    return instructions + `Conversation so far:\n\n${history}\n\nNow reply to:\n\n${question}`;
  }
  return instructions + question;
}

/**
 * Stream a reply for one turn of an idea page's chat. Runs on the same proven
 * path as {@link runAsk} (reconnect, cancellation, delta/done handling); the
 * prompt keeps the orchestrator pointed at this one card the whole thread, so
 * every agreed tweak lands on it via upsert_card instead of spawning duplicates.
 */
export function runIdeaChat(
  idea: IdeaRef,
  question: string,
  cb: AskCallbacks,
  session: SessionOpts,
  context?: AskContext,
): AskHandle {
  return runAsk(buildIdeaPrompt(idea, question, context), cb, session);
}

// Frame the dashboard itself as the subject of the conversation. Unlike /talk
// (pinned to one notebook's notes) or the idea page's chat (pinned to one card),
// this is pinned to the *cards*: the user is looking at their dashboard and
// saying what should be on it, so every turn is an instruction about tasks and
// ideas — create, change, or remove — carried out with the orchestrator's
// list_cards / upsert_card / dismiss_card.
//
// It's dictated, which shapes two of the rules below. Speech is loose ("drop the
// thing about the invoice"), so matching by meaning against the cards that
// already exist has to come first — rule 1 — or a reworded task becomes a second
// copy of itself. And the reply lands in a small card floating over the
// dashboard, the same constraint the idea page's reply card has, so it's asked to
// be short and to mark itself up (the card renders Markdown through
// ChatMarkdown, where bold reads heavy and inline code green).
function buildDashboardPrompt(
  question: string,
  scope: string | null,
  context?: AskContext,
): string {
  const instructions =
    "You are managing the user's dashboard — the task and idea cards held by the " +
    'orchestrator MCP. They are looking at that dashboard and talking to you about it, ' +
    'by voice, so treat what they say as an instruction about their cards rather than a ' +
    'general question.\n\n' +
    (scope
      ? `They are viewing the "${scope}" notebook, so read and write cards with ` +
        `source="${scope}" unless they name a different subject.\n\n`
      : 'They are viewing every notebook at once, so the card they mean may belong to any ' +
        "subject. Set a new card's source to the subject slug it belongs with, or leave it " +
        'off when it belongs to no notebook in particular.\n\n') +
    'How to work:\n' +
    "1. ALWAYS call the orchestrator's list_cards" +
    (scope ? ` with source="${scope}"` : '') +
    ' before writing anything. Spoken instructions are loose, so this is how you find ' +
    'which existing card the user means — match on meaning, not on exact wording.\n' +
    '2. To add a task, call upsert_card with kind="task", an honest priority (urgent | ' +
    'high | normal | low), and a date whenever one is stated or clearly implied ' +
    '("Friday", "before the end of the month").\n' +
    "3. To change one — retitle, reschedule, reprioritize, reword — call upsert_card " +
    "again with that same card's id so it updates in place instead of duplicating. To " +
    'mark one done or reopen it, pass that id with done=true / done=false.\n' +
    '4. To remove one (the user says delete, drop, cancel, get rid of it), call ' +
    'dismiss_card with its id.\n' +
    '5. Ideas are the same three verbs on kind="idea" cards. File one with 1–4 short ' +
    'lowercase tags and a Markdown body carrying the sections "## Problem", "## Idea", ' +
    '"## Project plan" and "## Next steps" — filled in from what the user said, leaving ' +
    'a section empty when it was not covered. Refine an idea by reusing its id; never ' +
    'file a second card for an idea that already has one.\n' +
    '6. Act, do not ask permission. The user asked out loud for a change whose result is ' +
    'on the dashboard behind this conversation — make it, then say what you did. Ask only ' +
    'when you genuinely cannot tell which card they mean and a guess would change the ' +
    'wrong one.\n' +
    '7. Reply BRIEFLY: a sentence or two, or a short list. Your reply is shown in a small ' +
    'card floating over the dashboard, so mark it up in Markdown to make it scannable — ' +
    '**bold** on what changed, `inline code` on the concrete things you name (a card ' +
    "title, a date, a tag). Never paste a card's whole body back at the user.\n\n";
  const turns = context?.turns?.filter(t => t.q);
  if (turns && turns.length) {
    const history = turns.map(t => `User: ${t.q}\n\nAssistant: ${t.a || ''}`).join('\n\n');
    return instructions + `Conversation so far:\n\n${history}\n\nNow reply to:\n\n${question}`;
  }
  return instructions + question;
}

/**
 * Stream a reply for one turn of the dashboard's voice chat. Runs on the same
 * proven path as {@link runAsk} (reconnect, cancellation, delta/done handling);
 * the prompt points the orchestrator at the user's cards, so what they say about
 * a task or an idea lands on the dashboard rather than only in the reply.
 *
 * `scope` is the notebook the dashboard is filtered to (a subject slug), or null
 * on the Sandbox's aggregate view — it decides which cards are read back and
 * where a new one is filed.
 */
export function runDashboardChat(
  question: string,
  scope: string | null,
  cb: AskCallbacks,
  session: SessionOpts,
  context?: AskContext,
): AskHandle {
  return runAsk(buildDashboardPrompt(question, scope, context), cb, session);
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
    'for every note.\n' +
    '6. Capture any genuine idea, proposal, or feature worth keeping (a thought to ' +
    'revisit later — not an action item) as a card with upsert_card kind="idea": ' +
    'structure the body as Markdown with the sections "## Problem", "## Idea", ' +
    '"## Project plan", and "## Next steps", filling in what the notes support and ' +
    "leaving a section empty when the notes don't cover it; attach 1–4 short " +
    'lowercase tags for filtering (e.g. ux, sync, ai); set source to the subject ' +
    'slug and an honest priority. Only for real ideas — not every passing musing.\n\n' +
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
