/**
 * Helpers that run in a RestartShell worker process (the forked child).
 * Everything flows to the shell via IPC. Split from RestartShell so
 * it's physically obvious which code runs in which process.
 */

import { delay } from "app/common/delay";
import { isAffirmative } from "app/common/gutil";
import { getServerFlags } from "app/server/lib/FlexServer";

import * as http from "http";

// IPC messages exchanged between shell and worker.
export interface ShellToWorker { action: "connection"; }
export interface WorkerToShell { action: "ready" | "restart" | "busy"; }

export function isUnderRestartShell(): boolean {
  return isAffirmative(process.env.GRIST_UNDER_RESTART_SHELL);
}

/**
 * Create an http.Server that receives connections from the parent
 * RestartShell via IPC rather than binding a port itself. Passed into
 * MergedServer via its `server` option.
 */
export function createRestartShellWorkerServer(): http.Server {
  // Unref IPC so it alone doesn't keep the worker alive: on a failed
  // boot, handles drain and the process exits, matching pre-shell
  // Grist where a dead listen socket meant a dead process.
  process.channel?.unref();

  const server = http.createServer(getServerFlags());
  process.on("message", (msg: ShellToWorker, socket: any) => {
    if (msg?.action === "connection" && socket) {
      server.emit("connection", socket);
      socket.resume();
    }
  });
  return server;
}

/**
 * Tell the parent RestartShell that this worker is ready to accept
 * forwarded connections. Caller must wait until the server is fully
 * set up (including any testing hooks tests will probe for).
 */
export async function signalRestartShellReady(): Promise<void> {
  if (process.env.GRIST_TEST_RESTART_SHELL_READY_DELAY) {
    // While stalling the ready signal, optionally emit busy heartbeats, mirroring how a
    // worker doing slow startup work (e.g. downloading the full edition) keeps the shell's
    // watchdog from flagging it as stalled.
    const busyInterval = Number(process.env.GRIST_TEST_RESTART_SHELL_BUSY_INTERVAL) || 0;
    const heartbeat = busyInterval ? setInterval(signalRestartShellBusy, busyInterval) : undefined;
    try {
      await delay(Number(process.env.GRIST_TEST_RESTART_SHELL_READY_DELAY));
    } finally {
      if (heartbeat) { clearInterval(heartbeat); }
    }
  }
  const ready: WorkerToShell = { action: "ready" };
  process.send?.(ready);
}

/**
 * Tell the parent RestartShell that this worker is still doing legitimate,
 * long-running startup work (e.g. downloading the full edition) and is not
 * stalled. Resets the shell's unhealthy watchdog, so call it repeatedly (e.g.
 * on an interval) until the work completes and `signalRestartShellReady` runs.
 */
export function signalRestartShellBusy(): void {
  const busy: WorkerToShell = { action: "busy" };
  process.send?.(busy);
}
