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
 * The build stamped onto an idea card's payload by the server, or null. This —
 * not local component state — is what the idea page derives its lock from, so
 * the lock survives an app restart and is true on every device.
 */
export function cardBuild(
  card: DashboardCard,
): { slug: string; status: string; feature: number; start_at?: string } | null {
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
  };
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
 * Move the start time of a build that hasn't begun yet. Null brings it forward to
 * now, which is the same "Now" the picker offers when the build is first handed
 * over — so the server starts planning immediately, exactly as a due tick would.
 *
 * Only a build still waiting can be rescheduled: once planning has run there is a
 * plan written from the idea's wording, and the server answers 409. That's a race
 * the phone can lose honestly — the start time it was showing came round while the
 * dialog was open — so the message says the build has started rather than blaming
 * the request.
 */
export async function rescheduleBuild(slug: string, startAt: Date | null): Promise<BuildInfo> {
  return parseBuild(
    await request(
      '/build/schedule',
      { slug, ...(startAt ? { start_at: startAt.toISOString() } : {}) },
      'No build for that project.',
      'This build has already started, so its start time can no longer be moved.',
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
      return `**Waiting on you** — feature ${build.feature} is built. Complete its card on the dashboard to start the next one, or dismiss it to stop here.`;
    case 'done':
      return '**Done** — every feature in the plan is built and validated.';
    case 'halted':
      return '**Stopped.**';
    default:
      return build.status;
  }
}
