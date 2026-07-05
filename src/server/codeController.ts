/**
 * Bridges the editor's inline `/run <cmd>` command to the proven exec channel.
 *
 * Sibling to ./aiController: it reuses that module's global transport and paired-
 * server singletons (so "which laptop" stays single-sourced), and exposes the
 * same shape of synchronous handle the editor call sites expect — return
 * immediately, wire callbacks, do the async connect underneath. The heavy lifting
 * (pinned socket, live duplex framing) lives in ./execClient.
 */

import { exec, type ExecHandle } from './execClient';
import { getTransport, currentServer, NO_MODULE } from './aiController';
import { setServerStatus } from './status';

export interface RunCallbacks {
  /** A chunk of live output, tagged with its stream. */
  onLog: (stream: 'stdout' | 'stderr', data: string) => void;
  /** The command exited; `code` is its status (-1 if it was signalled/killed). */
  onExit: (code: number) => void;
  /** The run couldn't start or the connection dropped; terminal. */
  onError: (message: string) => void;
}

/** A live `/run` from the editor's side: feed it input, interrupt it, or stop it. */
export interface RunHandle {
  /** Send a line (or raw text) to the process's stdin. */
  sendStdin(data: string): void;
  /** Interrupt the process (wire Ctrl-C — SIGINT to the whole group). */
  interrupt(): void;
  /** Stop the run and tear down the socket. */
  stop(): void;
}

/**
 * Run `cmd` on the paired server (optionally under project subdir `dir`) and
 * stream it live. Returns immediately; callbacks fire as output arrives. The
 * connection is established asynchronously, so input issued before it is up is
 * buffered and replayed once the underlying socket exists.
 */
export function runCommand(cmd: string, dir: string | undefined, cb: RunCallbacks): RunHandle {
  let handle: ExecHandle | null = null;
  let stopped = false;
  // Input issued before the exec handle exists, flushed in order once it does.
  const pendingStdin: string[] = [];
  let pendingInterrupt = false;

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

    handle = exec(t, server, server.token, cmd, dir, {
      onLog: (stream, data) => {
        // Any frame off the socket proves the server is live right now.
        setServerStatus('connected');
        cb.onLog(stream, data);
      },
      onExit: code => cb.onExit(code),
      onError: msg => {
        setServerStatus('disconnected');
        cb.onError(msg);
      },
    });

    // Replay anything the user did during the connect window.
    for (const data of pendingStdin) handle.sendStdin(data);
    pendingStdin.length = 0;
    if (pendingInterrupt) handle.signal('SIGINT');
    if (stopped) handle.kill();
  })();

  return {
    sendStdin(data: string) {
      if (handle) handle.sendStdin(data);
      else pendingStdin.push(data);
    },
    interrupt() {
      if (handle) handle.signal('SIGINT');
      else pendingInterrupt = true;
    },
    stop() {
      stopped = true;
      handle?.kill();
    },
  };
}
