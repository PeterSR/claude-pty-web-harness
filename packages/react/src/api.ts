// Transport client for a claude-pty-harness server. baseUrl is injectable so
// the same hook works same-origin (Vite proxy), cross-origin, or in Electron.
import type { SessionSummary } from "@claude-pty-harness/protocol";

export interface HarnessClient {
  createSession(cwd: string, model?: string): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  killSession(id: string): Promise<void>;
  sendPrompt(id: string, text: string): Promise<void>;
  /** ws(s):// URL for the live transcript stream. */
  streamUrl(id: string): string;
}

/**
 * @param baseUrl Origin of the harness server, e.g. "http://127.0.0.1:4318".
 *   Empty string (default) means same-origin / relative (e.g. behind a proxy).
 */
export function createHarnessClient(baseUrl = ""): HarnessClient {
  const url = (p: string) => `${baseUrl}${p}`;

  const json = async (res: Response) => {
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  };

  return {
    createSession: (cwd, model) =>
      fetch(url("/api/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, model }),
      }).then(json),
    listSessions: () => fetch(url("/api/sessions")).then(json),
    killSession: async (id) => {
      await fetch(url(`/api/sessions/${id}`), { method: "DELETE" });
    },
    sendPrompt: async (id, text) => {
      await fetch(url(`/api/sessions/${id}/prompt`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    },
    streamUrl: (id) => {
      const origin = baseUrl || (typeof location !== "undefined" ? location.origin : "");
      const wsBase = origin.replace(/^http/, "ws");
      return `${wsBase}/api/sessions/${id}/stream`;
    },
  };
}
