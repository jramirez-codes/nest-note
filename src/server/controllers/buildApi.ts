/**
 * Scheduled idea builds: the client for the companion server's /build endpoints.
 *
 * Starting a build turns an idea card into a real project folder with a plan, and
 * arms a crontab entry that builds it one feature at a time — pausing after each
 * feature until the user validates it from the dashboard. This module is only the
 * three calls the idea page makes; the approve/reject half of the loop needs
 * nothing here, because it rides the dashboard's existing complete/dismiss verbs
 * on an ordinary card.
 *
 * Same pinned tunnel and bearer token as every other server call, and the same
 * 200-or-throw contract dashboardApi uses.
 */

import { getTransport, currentServer, serverOrigin, NO_MODULE } from '../transport/connection';
import { setServerStatus } from '../transport/status';
import type { DashboardCard } from './dashboardApi';

/** Statuses a build walks, in order. The two terminal ones release the schedule. */
export type BuildStatus =
  | 'scheduled'
  | 'planning'
  | 'building'
  | 'awaiting-validation'
  | 'done'
  | 'halted';

/** One "## Feature N" section of the project's PROJECT_PLAN.md. */
export interface BuildFeature {
  num: number;
  title: string;
  body: string;
  /** 'pending' for features the build hasn't reached; otherwise a BuildStatus. */
  status: string;
}

/** A project build, as `/build`, `/build/start` and `/build/stop` all report it. */
export interface BuildInfo {
  slug: string;
  card_id: string;
  source: string;
  status: BuildStatus;
  /** The feature being built or validated (1-based; 0 while still planning). */
  feature: number;
  gate_card_id?: string;
  last_run?: string;
  /** When a scheduled build is due to start, ISO 8601. Absent once it has. */
  start_at?: string;
  /** Why a build stalled — a crashed run, a plan that never landed. */
  note?: string;
  /** Absolute path of the project folder on the server. */
  project: string;
  /**
   * The plan's Overview section — the problem and the idea this project came from,
   * in the user's own words. Once the build files its first step card the idea card
   * is off the dashboard, so this (and that step card) is where the idea is read.
   */
  overview?: string;
  features: BuildFeature[];
  /** Session id this build's current run streams on, watchable via /code. */
  session: string;
}

/**
 * Whether a build in this state still holds the idea. Only the live statuses
 * lock the idea page: once a build is done or halted the idea is the user's to
 * talk about again.
 */
export function buildIsLive(status: string | undefined): boolean {
  return (
    status === 'scheduled' ||
    status === 'planning' ||
    status === 'building' ||
    status === 'awaiting-validation'
  );
}

/**
 * Whether a build in this state has taken the idea out of the user's hands.
 *
 * Not the same question as buildIsLive: a *scheduled* build holds the idea but
 * doesn't lock it. Nothing has been planned from its wording yet, so the idea is
 * still the user's to work on — and whatever it says when the start time comes
 * round is exactly what gets built. The lock lands with the planning run.
 */
export function buildLocksIdea(status: string | undefined): boolean {
  return buildIsLive(status) && status !== 'scheduled';
}

/**
 * The build stamped onto a card's payload by the server, or null. This — not local
 * component state — is what a card's page derives its build state from, so it
 * survives an app restart and is true on every device.
 *
 * Both cards a build touches carry it, in the same shape: the idea it was started
 * from, and each build-step card it files. So a step card opened from the dashboard
 * shows what the build is actually doing on its first frame, rather than defaulting
 * to "nothing is running here" until /build answers.
 */
export function cardBuild(
  card: DashboardCard,
): {
  slug: string;
  status: string;
  feature: number;
  start_at?: string;
  /** The name of the idea this build came from — what a step card is titled by. */
  idea?: string;
  /** Why the build is where it is: what the last run reported, or why it stopped. */
  note?: string;
} | null {
  const raw = card.payload?.build;
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const slug = String(b.slug ?? '');
  if (!slug) return null;
  return {
    slug,
    status: String(b.status ?? ''),
    feature: typeof b.feature === 'number' ? b.feature : 0,
    start_at: typeof b.start_at === 'string' ? b.start_at : undefined,
    idea: typeof b.idea === 'string' && b.idea ? b.idea : undefined,
    note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : undefined,
  };
}

/**
 * How a build's state reads on a dashboard row, or null for a card no build has
 * touched. Five tones, because a row has room for a colour and two or three words
 * and the user only needs to know which of five things is true: a run is placed at
 * a minute, a run is going, the build is parked on the user, it stopped, it
 * finished.
 *
 * Read off the card's own stamp, like everything else about a build the dashboard
 * shows — the list never fetches /build, so the row is right on its first frame and
 * stays right without a request per card.
 *
 * The wording is deliberately the idea page's wording. A row and the page it opens
 * are the same fact at two sizes, and "Waiting on you" on the row landing on
 * "Waiting on you" in the header is what makes the tap feel like a zoom rather than
 * a jump.
 */
export type BuildBadgeTone = 'scheduled' | 'running' | 'waiting' | 'stopped' | 'done';

export interface BuildBadge {
  tone: BuildBadgeTone;
  /** The state, in a word or three. */
  label: string;
  /** What the row adds to it: the start time, or why a stopped build stopped. */
  detail?: string;
}

export function buildBadge(card: DashboardCard): BuildBadge | null {
  const build = cardBuild(card);
  if (!build) return null;
  const at = build.start_at ? new Date(build.start_at) : null;
  switch (build.status) {
    // A run placed at a minute that hasn't come round. Both statuses that can hold
    // a start time say the same thing here, because it *is* the same thing — an
    // idea handed over for later, and a step whose sign-off named a time for the
    // feature after it. Only the run being waited on differs, and the row isn't
    // where that distinction is drawn (the page it opens is).
    case 'scheduled':
      return { tone: 'scheduled', label: 'Scheduled', detail: at ? startLabel(at) : undefined };
    case 'awaiting-validation':
      return at
        ? { tone: 'scheduled', label: 'Scheduled', detail: startLabel(at) }
        : { tone: 'waiting', label: 'Waiting on you' };
    // A run is in flight. Which of the two it is matters — planning is the run that
    // takes the idea out of the user's hands — but either way nothing is being
    // asked of them until it lands.
    case 'planning':
      return { tone: 'running', label: 'Planning' };
    case 'building':
      return { tone: 'running', label: 'Building' };
    // Stopped, and the note is why. That's the one thing worth a row's width here:
    // "Stopped" alone would send the user into the page to learn what a handful of
    // characters could have told them.
    case 'halted':
      return { tone: 'stopped', label: 'Stopped', detail: build.note };
    case 'done':
      return { tone: 'done', label: 'Done' };
    // A status this build of the app doesn't know. Shown as itself rather than
    // dropped — the same bet the card list makes with an unknown kind, and a row
    // saying a word we don't recognise beats a row silently saying nothing.
    default:
      return build.status ? { tone: 'waiting', label: build.status } : null;
  }
}

/**
 * What a build-step card is *about*: the feature it asked you to validate, and
 * what that feature is called.
 *
 * Read from `payload.step` rather than from the build stamp beside it, because the
 * two answer different questions. The stamp travels with the build — a step the
 * build has moved past is re-stamped with the state it moved *to* — while this is
 * the step's own identity and never changes after the card is filed. A row saying
 * "Feature 2" has to still say "Feature 2" once the build reaches feature 5.
 *
 * Null for anything that isn't a step card, and for step cards filed before the
 * idea moved onto them (their title is still the feature's own).
 */
export function cardStep(card: DashboardCard): { feature: number; title?: string } | null {
  const raw = card.payload?.step;
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.feature !== 'number') return null;
  return {
    feature: s.feature,
    title: typeof s.title === 'string' && s.title ? s.title : undefined,
  };
}

/**
 * The one line a step card says about itself under the idea's name: which feature
 * it is, and what that feature is called. Falls back to the project it belongs to
 * for a card filed before steps carried a `step` payload, so every step row has a
 * second line and the list keeps one row height.
 */
export function stepLabel(card: DashboardCard): string {
  const step = cardStep(card);
  if (!step) return cardBuild(card)?.slug ?? 'Build step';
  const n = `Feature ${step.feature}`;
  return step.title ? `${n} — ${step.title}` : n;
}

// Shared request path for the /build endpoints. Mirrors dashboardApi's contract:
// 200 → parse and mark connected, 404 → a specific message, anything else →
// mark disconnected and throw.
async function request(
  path: string,
  body?: Record<string, unknown>,
  notFoundMsg = 'No build for that project.',
  conflictMsg = 'That project already has a build running.',
): Promise<string> {
  const t = getTransport();
  if (!t) throw new Error(NO_MODULE);
  const server = await currentServer();
  if (!server) throw new Error('Not connected. Pair first with “/pair <payload>”.');

  const res = await t.postPinned(`${serverOrigin(server)}${path}`, server.pin, {
    headers: {
      Authorization: `Bearer ${server.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 404) throw new Error(notFoundMsg);
  if (res.status === 403) {
    // The operator's own decision, not a fault — say which flags rather than
    // leaving the user staring at a number.
    throw new Error('Builds are off on this server (start it with -allow-code and -allow-exec).');
  }
  if (res.status === 409) throw new Error(conflictMsg);
  if (res.status !== 200) {
    setServerStatus('disconnected');
    throw new Error(`Build unavailable (HTTP ${res.status}).`);
  }
  setServerStatus('connected');
  return res.text;
}

function parseBuild(text: string): BuildInfo {
  const data = JSON.parse(text) as Partial<BuildInfo>;
  return {
    slug: String(data.slug ?? ''),
    card_id: String(data.card_id ?? ''),
    source: String(data.source ?? ''),
    status: (data.status ?? 'planning') as BuildStatus,
    feature: typeof data.feature === 'number' ? data.feature : 0,
    gate_card_id: data.gate_card_id,
    last_run: data.last_run,
    start_at: data.start_at,
    note: data.note,
    project: String(data.project ?? ''),
    overview: data.overview,
    features: Array.isArray(data.features) ? data.features : [],
    session: String(data.session ?? ''),
  };
}

/**
 * Start a build from an idea card: the server creates projects/<slug>, seeds it,
 * runs the planning agent, and installs the crontab entry that will build each
 * feature in turn. `project` is the human name — the server slugs it the same way
 * `/code <name>` does, so the same name always maps to the same folder.
 *
 * `startAt` defers all of that except the folder: the server writes the crontab
 * entry for the minute given and the build waits there, planning nothing until
 * then. Null (the default the picker opens on) means now. A time that has all but
 * arrived is treated as now server-side, so the two phone clocks disagreeing by a
 * few seconds can't leave a build waiting for a minute that has already gone.
 */
export async function startBuild(
  card: DashboardCard,
  project: string,
  startAt: Date | null = null,
): Promise<BuildInfo> {
  return parseBuild(
    await request(
      '/build/start',
      {
        card_id: card.id,
        source: card.source ?? '',
        project,
        ...(startAt ? { start_at: startAt.toISOString() } : {}),
      },
      'That idea is no longer on the server.',
    ),
  );
}

/**
 * Say when a build's next run happens. Null means now, which is the same "Now" the
 * picker offers when the build is first handed over — the server starts on this
 * request rather than at the next tick, exactly as a due tick would.
 *
 * Two states can answer that question, and the call is the same in both:
 *
 * - `scheduled` — the first run. Nothing has been planned from the idea yet, so
 *   this only moves which minute cron fires at.
 * - `awaiting-validation` — the next feature, from the step card the build is
 *   parked on. Picking a time here validates that step on the way past: choosing
 *   when the next feature runs is an acceptance of the one that just did.
 *
 * Anything else has no next run to place and the server answers 409 — a race the
 * phone can lose honestly, since the time it was showing may have come round while
 * the dialog was open.
 */
export async function scheduleBuild(slug: string, startAt: Date | null): Promise<BuildInfo> {
  return parseBuild(
    await request(
      '/build/schedule',
      { slug, ...(startAt ? { start_at: startAt.toISOString() } : {}) },
      'No build for that project.',
      'This build has moved on, so there is no run left to schedule.',
    ),
  );
}

/**
 * Send what the user said about the feature they were just shown back into the
 * project: a change to the feature, or to the plan, or both. The server runs it in
 * the project directory and pauses at the same step again afterwards, so a revision
 * is reviewed exactly like the build that prompted it.
 *
 * Only while the build is paused at that step. Anywhere else a run is either
 * already going or there is nothing paused to talk about, and the server answers
 * 409 rather than putting a second agent in the same working tree.
 */
export async function reviseBuild(slug: string, note: string): Promise<BuildInfo> {
  return parseBuild(
    await request(
      '/build/revise',
      { slug, note },
      'No build for that project.',
      'This build isn’t paused at a step, so there is nothing to change yet.',
    ),
  );
}

/** Read a build's state and its parsed plan — what the progress toggle renders. */
export async function fetchBuild(slug: string): Promise<BuildInfo> {
  return parseBuild(await request(`/build?slug=${encodeURIComponent(slug)}`));
}

/**
 * Stop a build for good: the crontab entry goes, any run in flight is killed, and
 * the idea unlocks. The project folder and everything built so far stay put.
 */
export async function stopBuild(slug: string): Promise<BuildInfo> {
  return parseBuild(await request('/build/stop', { slug }));
}

/**
 * The way back from a stop: put a halted build back at the step it reached, with
 * its step card asking for a decision again and its crontab entry reinstalled.
 *
 * Nothing runs on this call. A resumed build lands in `awaiting-validation` — the
 * state the step page is built around — so what happens next is the same choice it
 * always is: say when the next feature runs, or say what to change first.
 *
 * Only from `halted`. A live build has nothing to resume and a finished one has no
 * step left to go back to, so both answer 409; so does a build that stopped before
 * it ever built a feature, which is a `/build/start` away rather than this.
 */
export async function resumeBuild(slug: string): Promise<BuildInfo> {
  return parseBuild(
    await request(
      '/build/resume',
      { slug },
      'No build for that project.',
      'This build isn’t stopped, so there is nothing to pick back up.',
    ),
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A build's start time as the app says it: "now", a time today, or a weekday and
 * date. Both the picker and the page that reads its choice back go through here,
 * so what you confirm is worded exactly like what you then see.
 *
 * Formatted by hand rather than through toLocaleTimeString: Intl options are
 * unevenly honoured across Hermes builds, and a 24-hour clock is what the crontab
 * underneath this speaks anyway.
 */
export function startLabel(at: Date | null): string {
  if (!at) return 'now';
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  switch (dayGap(new Date(), at)) {
    case 0:
      return `today at ${time}`;
    case 1:
      return `tomorrow at ${time}`;
    default:
      return `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} at ${time}`;
  }
}

/** Whole calendar days between two instants, ignoring the time of day. */
function dayGap(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * Render a build's plan as Markdown for the idea page's progress view, with each
 * feature's state in front of its title. It goes through the same NotePage editor
 * the idea body uses, so this needs no renderer of its own.
 *
 * The plan opens with the project's **overview** — the problem and the idea it
 * came from — above the features. That's not decoration: from the build's first
 * step card onwards the idea has no card of its own in the Ideas section, and this
 * is where "what is this project even for" is answered.
 */
export function planMarkdown(build: BuildInfo): string {
  const mark = (status: string): string => {
    switch (status) {
      case 'scheduled':
        return '🕒';
      case 'done':
        return '✅';
      case 'building':
        return '⏳';
      case 'awaiting-validation':
        return '🔎';
      case 'halted':
        return '✋';
      default:
        return '⬜';
    }
  };
  const head = [`# ${build.slug}`, '', statusLine(build), '', `\`${build.project}\``, ''];
  if (build.note) head.push('', `> ${build.note}`, '');
  // The overview sits between the build's own state and the plan proper: the plan
  // is a list of features, and this says what they add up to.
  const overview = build.overview?.trim();
  if (overview) head.push('', '## Overview', '', overview, '');
  if (build.features.length === 0) {
    head.push('', emptyPlanNote(build.status));
    return head.join('\n');
  }
  const body = build.features.map(f =>
    [`## ${mark(f.status)} Feature ${f.num}: ${f.title}`, '', f.body].join('\n'),
  );
  return [...head, ...body].join('\n\n');
}

/** Why there are no features to show yet — which is normal in two of these. */
function emptyPlanNote(status: BuildStatus): string {
  switch (status) {
    case 'scheduled':
      return '_The plan gets written when the build starts._';
    case 'planning':
      return '_Claude is writing the project plan…_';
    default:
      return '_No plan on disk yet._';
  }
}

/** One human line saying where the build has got to. */
function statusLine(build: BuildInfo): string {
  switch (build.status) {
    case 'scheduled':
      return `**Scheduled** — the plan gets written ${startLabel(
        build.start_at ? new Date(build.start_at) : null,
      )}, and the first feature straight after it. Until then the idea is still yours to change.`;
    case 'planning':
      return '**Planning** — writing the project plan.';
    case 'building':
      return `**Building feature ${build.feature}.**`;
    case 'awaiting-validation':
      return build.start_at
        ? `**Feature ${build.feature} is validated** — the next one starts ${startLabel(
            new Date(build.start_at),
          )}. Nothing runs until then.`
        : `**Waiting on you** — feature ${build.feature} is built. Say when the next one should start from its build step, complete its card on the dashboard, or dismiss it to stop here.`;
    case 'done':
      return '**Done** — every feature in the plan is built and validated.';
    case 'halted':
      return '**Stopped.**';
    default:
      return build.status;
  }
}
