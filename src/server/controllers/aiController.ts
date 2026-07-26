/**
 * Barrel for the companion-server client layer.
 *
 * The concerns that used to live in this one file are now three focused modules,
 * re-exported here so `../server/aiController` stays the single import surface the
 * rest of the app already uses:
 *
 *   - ./connection    — shared pinned transport + paired-server singletons,
 *                       pairing, and the reachability probe.
 *   - ./assistantRuns — the streaming /ask, /clean, /ingest and /talk runs.
 *   - ./dashboardApi  — the dashboard/notebook HTTP read+write API and its types.
 *
 * Sibling controllers (./codeController, ./agentController, ./viewController) and
 * ./runRegistry import their shared primitives (getTransport, currentServer,
 * NO_MODULE, runAsk/runClean/runIngest) from here, so "which laptop are we talking
 * to" stays single-sourced through the connection singletons.
 */

export {
  getTransport,
  currentServer,
  serverOrigin,
  pingServer,
  pairFromPayload,
  NO_MODULE,
} from '../transport/connection';

export {
  runAsk,
  runClean,
  runIngest,
  runNotesChat,
  runIdeaChat,
  runAggTasks,
  type AskCallbacks,
  type AskHandle,
  type AskContext,
  type IdeaRef,
  type CleanCallbacks,
  type IngestCallbacks,
  type AggTasksCallbacks,
} from './assistantRuns';

export {
  fetchNotebook,
  fetchNotebookIndex,
  fetchPage,
  fetchDashboardState,
  fetchCard,
  getCachedDashboardState,
  setCachedDashboardState,
  applyDashboardAction,
  applyReorgAction,
  completeCard,
  dismissCard,
  searchNotes,
  type NotePage,
  type DashboardServer,
  type NotebookDetail,
  type DashboardSuggestion,
  type DashboardReorg,
  type CardPriority,
  type DashboardCard,
  type DashboardState,
  type SearchResult,
} from './dashboardApi';
