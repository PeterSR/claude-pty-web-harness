// Resolve the pupptyeer daemon socket and ensure a daemon is running.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PupptyeerClient } from "@petersr/pupptyeer-client";

export interface DaemonOptions {
  /** Override the daemon socket path. Falls back to env / XDG / tmp. */
  socketPath?: string;
  /** Path or name of the pupptyeer binary. Falls back to env / PATH. */
  pupptyeerBin?: string;
}

/** Mirror of the daemon's socket-path resolution (see pupptyeer --help). */
export function resolveSocketPath(opts: DaemonOptions = {}): string {
  if (opts.socketPath) return opts.socketPath;
  if (process.env.PUPPTYEER_SOCK) return process.env.PUPPTYEER_SOCK;
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, "pupptyeer", "daemon.sock");
  }
  const tmp = process.env.TMPDIR || "/tmp";
  return path.join(tmp, `pupptyeer-${os.userInfo().uid}`, "daemon.sock");
}

/** Path to the pupptyeer binary. Caller supplies it; else env; else PATH. */
function resolveBinary(opts: DaemonOptions): string {
  return opts.pupptyeerBin || process.env.PUPPTYEER_BIN || "pupptyeer";
}

function canConnect(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: sockPath });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connect to the pupptyeer daemon, spawning one if the socket is dead.
 * Returns a connected client.
 */
export async function connectDaemon(opts: DaemonOptions = {}): Promise<PupptyeerClient> {
  const sockPath = resolveSocketPath(opts);

  if (!(await canConnect(sockPath))) {
    const bin = resolveBinary(opts);
    console.log(`[daemon] no live socket at ${sockPath}; spawning ${bin} daemon`);
    const child = spawn(bin, ["daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();

    let up = false;
    for (let i = 0; i < 50; i++) {
      if (await canConnect(sockPath)) {
        up = true;
        break;
      }
      await sleep(100);
    }
    if (!up) {
      throw new Error(
        `pupptyeer daemon did not come up at ${sockPath}. Set pupptyeerBin/PUPPTYEER_BIN or start it manually.`,
      );
    }
  }

  console.log(`[daemon] connected at ${sockPath}`);
  return PupptyeerClient.connect(sockPath);
}
