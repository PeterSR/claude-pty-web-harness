// Transport client for a claude-pty-web-harness server. baseUrl is injectable so
// the same hook works same-origin (Vite proxy), cross-origin, or in Electron.
import type { SessionSummary } from "@petersr/claude-pty-web-harness-protocol";

export interface HarnessClient {
  createSession(cwd: string, model?: string): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  killSession(id: string): Promise<void>;
  sendPrompt(id: string, text: string): Promise<void>;
  /** ws(s):// URL for the live transcript stream. */
  streamUrl(id: string): string;
  /**
   * URL for an image ContentPart's bytes (an <img src>). Unlike streamUrl this
   * never needs to be absolute - a relative path works fine as an <img> src -
   * so it stays usable with the default same-origin baseUrl ("").
   */
  blobUrl(id: string, blobId: string): string;
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

  // Throw on a non-2xx response for endpoints whose body we don't need.
  const ensureOk = async (res: Response) => {
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
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
      await fetch(url(`/api/sessions/${id}`), { method: "DELETE" }).then(ensureOk);
    },
    sendPrompt: async (id, text) => {
      await fetch(url(`/api/sessions/${id}/prompt`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).then(ensureOk);
    },
    streamUrl: (id) => {
      const origin = baseUrl || (typeof location !== "undefined" ? location.origin : "");
      // A relative URL can't open a WebSocket, so fail loud instead of returning
      // one. This bites in SSR (no location) or with a non-http base URL.
      if (!origin) {
        throw new Error("streamUrl: no origin (SSR without a baseUrl); pass an explicit http(s) baseUrl");
      }
      if (!/^https?:\/\//.test(origin)) {
        throw new Error(`streamUrl: baseUrl must start with http:// or https:// (got "${origin}")`);
      }
      const wsBase = origin.replace(/^http/, "ws");
      return `${wsBase}/api/sessions/${id}/stream`;
    },
    blobUrl: (id, blobId) => url(`/api/sessions/${id}/blobs/${blobId}`),
  };
}
