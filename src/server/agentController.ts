/**
 * Bridges the editor's inline `/code <name>` command to the proven agent channel.
 *
 * Sibling to ./codeController (which bridges `/run`): it reuses ./aiController's
 * global transport and paired-server singletons (so "which laptop" stays single-
 * sourced), and exposes the synchronous handle the editor call sites expect —
 * return immediately, wire callbacks, do the async connect underneath. The heavy
 * lifting (pinned socket, multi-turn stream-json framing) lives in ./agentClient.
 */

import { openAgent, listProjects, type AgentHandle } from './agentClient';
import { getTransport, currentServer, NO_MODULE } from './aiController';
import { setServerStatus } from './status';
import type { StreamEvent } from './protocol';
import type { SessionOpts } from './client';

export interface CodeCallbacks {
  /** A parsed Claude stream event: assistant text/deltas, tool calls/results, results. */
  onEvent: (ev: StreamEvent) => void;
  /** The session ended (agent exited or socket closed). Terminal. */
  onExit: () => void;
  /** The session couldn't start or the connection dropped; terminal. */
  onError: (message: string) => void;
}

/** A live `/code` session from the editor's side: send a turn, or stop it. */
export interface CodeHandle {
  /** Send a follow-up prompt as the next turn in the running session. */
  prompt(text: string): void;
  /** Stop the session and tear down the socket. */
  stop(): void;
}

/**
 * Open a Claude Code session in project `name` (created if missing) on the paired
 * server, optionally kicking it off with `firstPrompt`, and stream it live.
 * Returns immediately; callbacks fire as output arrives. The connection is
 * established asynchronously, so prompts issued before it is up are buffered and
 * replayed once the underlying socket exists.
 */
export function startCode(
  name: string,
  firstPrompt: string | undefined,
  cb: CodeCallbacks,
  session: SessionOpts,
): CodeHandle {
  let handle: AgentHandle | null = null;
  let stopped = false;
  // Prompts issued before the agent handle exists, flushed in order once it does.
  const pendingPrompts: string[] = [];

  (async () => {
    const t = getTransport();
    if (!t) {
      cb.onError(NO_MODULE);
      return;
    }
    const server = await currentServer();
    if (!server) {
      cb.onError('Not connected. Pair first with “/pair <payload>”.');
      return;
    }
    if (stopped) return; // stopped before we even connected

    handle = openAgent(
      t,
      server,
      server.token,
      name,
      firstPrompt,
      {
        onEvent: ev => {
          // Any frame off the socket proves the server is live right now.
          setServerStatus('connected');
          cb.onEvent(ev);
        },
        onExit: () => cb.onExit(),
        onError: msg => {
          setServerStatus('disconnected');
          cb.onError(msg);
        },
      },
      session,
    );

    // Replay anything the user queued during the connect window.
    for (const text of pendingPrompts) handle.prompt(text);
    pendingPrompts.length = 0;
    if (stopped) handle.kill();
  })();

  return {
    prompt(text: string) {
      if (handle) handle.prompt(text);
      else pendingPrompts.push(text);
    },
    stop() {
      stopped = true;
      handle?.kill();
    },
  };
}

/**
 * List the project directories on the paired server so the editor can
 * autocomplete `/code <name>`. Reuses the shared transport/server singletons
 * (like startCode), and resolves to an empty list when nothing is paired or the
 * server can't be reached — so the caller never has to handle an error path.
 */
export async function fetchProjects(): Promise<string[]> {
  const t = getTransport();
  if (!t) return [];
  const server = await currentServer();
  if (!server) return [];
  return listProjects(t, server, server.token);
}
