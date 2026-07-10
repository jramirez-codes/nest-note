/**
 * The dashboard/notebook read + write API: the plain-HTTP endpoints the Go server
 * answers straight from the scaffold's files, without ever spinning up Claude.
 *
 * Everything here talks to the server over the same pinned tunnel /ask uses,
 * authenticated with the paired bearer token, and follows one contract: 200 →
 * parse the JSON body; anything else → mark disconnected and throw. Reads:
 * dashboard state, a notebook's detail or cheap page index, a single page body.
 * Writes: merge-suggestion actions and card complete/dismiss.
 */

import { getTransport, currentServer, serverOrigin, NO_MODULE } from '../transport/connection';
import { setServerStatus } from '../transport/status';
import type { PairedServer } from '../transport/store';

/**
 * One markdown page in a notebook's notes/ folder. `num` is the page number (0 = the
 * auto-generated Appendix), `title` is the parenthesized name, `file` is the on-disk
 * "#N (Title).md", and `body` is the raw markdown (which may carry [[wikilinks]]).
 */
export interface NotePage {
  num: number;
  title: string;
  file: string;
  body: string;
}

export interface DashboardServer {
  /** Stable subject slug; cards key to a notebook via their `source` == this. */
  name: string;
  /** Display title from the notebook.json manifest (falls back to the slug). */
  title?: string;
  summary: string;
  /** Optional Lucide glyph name + Catppuccin hue from the manifest. */
  icon?: string;
  accent?: string;
  pinned?: boolean;
  updated_at?: string;
  tools: string[];
  /** This notebook's ordered notes pages; pages[0] is the Appendix. */
  pages: NotePage[];
}

/** One notebook's full detail from `GET /notebook?slug=x` (the lazy swap fetch). */
export interface NotebookDetail extends DashboardServer {
  cards: DashboardCard[];
}

export interface DashboardSuggestion {
  into: string;
  from: string[];
  reason: string;
}

/** Priority ranks, high→low, so the UI can sort without hard-coding the strings. */
export type CardPriority = 'urgent' | 'high' | 'normal' | 'low';

/**
 * One dashboard card, straight off the wire. Deliberately flat and kind-agnostic:
 * `kind` selects a renderer (with a generic fallback for unknown kinds), so Claude
 * can emit a new kind and it shows up with zero new code. `payload` is opaque
 * kind-specific extras a bespoke renderer may read later.
 */
export interface DashboardCard {
  id: string;
  kind: string;
  priority: CardPriority;
  /** Optional ISO date: a task's due date. */
  date?: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  done?: boolean;
  dismissed?: boolean;
  source?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DashboardState {
  servers: DashboardServer[];
  suggestions: DashboardSuggestion[];
  cards: DashboardCard[];
}

/**
 * GET a pinned, bearer-authenticated endpoint. Throws `notFoundMsg` on 404 and
 * `unavailableMsg` (after marking disconnected) on any other non-200; a 200 marks
 * connected and returns the raw response text for the caller to parse.
 */
async function getJson(
  path: string,
  notFoundMsg: string,
  unavailableMsg: string,
): Promise<string> {
  const t = getTransport();
  if (!t) throw new Error(NO_MODULE);
  const server = await currentServer();
  if (!server) throw new Error('Not connected. Pair first with “/pair <payload>”.');

  const res = await t.postPinned(`${serverOrigin(server)}${path}`, server.pin, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  if (res.status === 404) throw new Error(notFoundMsg);
  if (res.status !== 200) {
    setServerStatus('disconnected');
    throw new Error(`${unavailableMsg} (HTTP ${res.status}).`);
  }
  // Any answer off the socket proves the server is live right now.
  setServerStatus('connected');
  return res.text;
}

// requestNotebook is the shared GET /notebook path. `metaOnly` asks the server for the
// cheap index form (?meta=1): the page list keeps its num/title/file but drops every body,
// which the caller then fetches one page at a time via {@link fetchPage} to virtualize a
// long notebook. Without it the eager form returns every page body inline.
async function requestNotebook(slug: string, metaOnly: boolean): Promise<NotebookDetail> {
  const path =
    `/notebook?slug=${encodeURIComponent(slug)}` + (metaOnly ? '&meta=1' : '');
  const text = await getJson(
    path,
    'That notebook no longer exists.',
    'Notebook unavailable',
  );
  const data = JSON.parse(text) as Partial<NotebookDetail>;
  return {
    name: String(data.name ?? slug),
    title: data.title,
    summary: data.summary ?? '',
    icon: data.icon,
    accent: data.accent,
    pinned: data.pinned,
    updated_at: data.updated_at,
    tools: Array.isArray(data.tools) ? data.tools : [],
    pages: Array.isArray(data.pages) ? data.pages : [],
    cards: Array.isArray(data.cards) ? data.cards : [],
  };
}

/** Fetch a single notebook's full detail (manifest + notes with bodies + its own cards). */
export async function fetchNotebook(slug: string): Promise<NotebookDetail> {
  return requestNotebook(slug, false);
}

/**
 * Fetch a notebook's cheap page index: the ordered page stubs (num/title/file, Appendix
 * first) with empty bodies, plus its cards. The phone opens a notebook with this, then
 * pulls individual page bodies via {@link fetchPage} as the reader moves.
 */
export async function fetchNotebookIndex(slug: string): Promise<NotebookDetail> {
  return requestNotebook(slug, true);
}

/** Fetch one page's markdown body by page number (0 = the Appendix). */
export async function fetchPage(slug: string, num: number): Promise<NotePage> {
  const text = await getJson(
    `/page?slug=${encodeURIComponent(slug)}&num=${num}`,
    'That page no longer exists.',
    'Page unavailable',
  );
  const data = JSON.parse(text) as Partial<NotePage>;
  return {
    num: typeof data.num === 'number' ? data.num : num,
    title: String(data.title ?? ''),
    file: String(data.file ?? ''),
    body: String(data.body ?? ''),
  };
}

/**
 * One page match from `GET /search?q=`: enough to render an autocomplete row
 * (the owning notebook, the page, a snippet of where the query hit) and to
 * build a `[[slug::#N (Title)]]` link to it.
 */
export interface SearchResult {
  slug: string;
  title: string;
  page_num: number;
  page_title: string;
  snippet: string;
}

/**
 * Search every notebook's pages for `query` (case-insensitive, title or body)
 * — the editor's `/search <query>` autocomplete calls this on every keystroke.
 * An empty/whitespace-only query resolves to `[]` without a round trip; any
 * other failure (nothing paired, server started without -root, unreachable)
 * also resolves to `[]` rather than throwing, since the caller is a menu that
 * should just show no suggestions, not surface an error mid-typing.
 */
export async function searchNotes(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  let text: string;
  try {
    text = await getJson(`/search?q=${encodeURIComponent(q)}`, 'no results', 'no results');
  } catch {
    return [];
  }
  const data = JSON.parse(text) as { results?: unknown };
  if (!Array.isArray(data.results)) return [];
  return data.results
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map(r => ({
      slug: String(r.slug ?? ''),
      title: String(r.title ?? ''),
      page_num: typeof r.page_num === 'number' ? r.page_num : 0,
      page_title: String(r.page_title ?? ''),
      snippet: String(r.snippet ?? ''),
    }))
    .filter(r => r.slug !== '' && r.page_title !== '');
}

// The last dashboard state we held, kept in module scope so it outlives the
// DashboardPage component. The pager unmounts non-current pages, so swiping away
// from the dashboard and back would otherwise drop its data and flash the loading
// spinner on every return. Seeding a remount from this cache paints the last-known
// cards instantly while a background refresh reconciles with the server.
let dashboardCache: DashboardState | null = null;
export function getCachedDashboardState(): DashboardState | null {
  return dashboardCache;
}
export function setCachedDashboardState(state: DashboardState | null): void {
  dashboardCache = state;
}

/** Fetch the dashboard's view of the MCP world (servers, their notes, suggestions). */
export async function fetchDashboardState(): Promise<DashboardState> {
  const text = await getJson(
    '/state',
    'This companion server has no dashboard (started without -root).',
    'Dashboard unavailable',
  );
  const data = JSON.parse(text) as Partial<DashboardState>;
  return {
    servers: Array.isArray(data.servers) ? data.servers : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    cards: Array.isArray(data.cards) ? data.cards : [],
  };
}

// postAction is the shared POST /action path: same pinned tunnel, bearer token, and
// 200-or-throw contract every dashboard write uses. Callers pass the verb-specific
// body (suggestion merges key on `into`, card actions on `id`).
async function postAction(body: Record<string, unknown>): Promise<void> {
  const t = getTransport();
  if (!t) throw new Error(NO_MODULE);
  const server = await currentServer();
  if (!server) throw new Error('Not connected.');

  const res = await t.postPinned(`${serverOrigin(server)}/action`, server.pin, {
    headers: {
      Authorization: `Bearer ${server.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`Action failed (HTTP ${res.status}).`);
}

/** Approve ('merge') or 'dismiss' an optional merge suggestion from the dashboard. */
export async function applyDashboardAction(action: {
  action: 'merge' | 'dismiss';
  into: string;
  from?: string[];
}): Promise<void> {
  return postAction(action);
}

/**
 * Toggle a task card's done state (`done` chooses complete vs. uncomplete).
 * `source` (the card's notebook slug) lets the server jump straight to the file
 * instead of scanning every notebook; it's optional and safely omitted when unknown.
 */
export async function completeCard(id: string, done: boolean, source?: string): Promise<void> {
  return postAction({ action: done ? 'complete' : 'uncomplete', id, source });
}

/** Dismiss a card so it stops showing in the dashboard. `source` is its notebook slug. */
export async function dismissCard(id: string, source?: string): Promise<void> {
  return postAction({ action: 'dismiss', id, source });
}

// Re-exported so `import type { PairedServer }` consumers that reached it through
// this API keep working; the canonical definition lives in ./store.
export type { PairedServer };
