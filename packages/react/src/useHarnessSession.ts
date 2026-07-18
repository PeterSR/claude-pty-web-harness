// Headless hook that owns the WebSocket to a harness session: collects the
// transcript, tracks status, exposes sendPrompt / interrupt. No UI; render the
// returned `events` however you like.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createHarnessClient } from "./api";
import type { ChatEvent, ClientMessage, ServerMessage, SessionStatus } from "@petersr/claude-pty-web-harness-protocol";

export interface UseHarnessSessionOptions {
  /** Harness server origin. Empty = same-origin (e.g. behind a dev proxy). */
  baseUrl?: string;
}

export interface HarnessSession {
  events: ChatEvent[];
  status: SessionStatus;
  /** Failure reason (a StartupFailure) when status is "failed", else null. */
  error: string | null;
  connected: boolean;
  sendPrompt: (text: string) => void;
  interrupt: () => void;
}

export function useHarnessSession(
  sessionId: string | null,
  options: UseHarnessSessionOptions = {},
): HarnessSession {
  const { baseUrl = "" } = options;
  const client = useMemo(() => createHarnessClient(baseUrl), [baseUrl]);

  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [status, setStatus] = useState<SessionStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    setStatus("starting");
    setError(null);

    const ws = new WebSocket(client.streamUrl(sessionId));
    wsRef.current = ws;
    const seen = new Set<string>();

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "status") {
        setStatus(msg.status);
        setError(msg.status === "failed" ? msg.error ?? "startup_timeout" : null);
      } else if (msg.type === "chat") {
        if (seen.has(msg.event.id)) return;
        seen.add(msg.event.id);
        const event = msg.event;
        setEvents((prev) => {
          // Drop only the single oldest optimistic local echo that matches, so
          // repeated identical prompts don't all vanish when one real entry lands.
          if (event.kind === "user") {
            const idx = prev.findIndex(
              (e) => e.id.startsWith("local-") && e.kind === "user" && e.text === event.text,
            );
            if (idx >= 0) {
              const next = prev.slice();
              next.splice(idx, 1);
              return [...next, event];
            }
          }
          return [...prev, event];
        });
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, client]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Optimistically show the user's prompt; the JSONL echo is de-duped by id.
      setEvents((prev) => [...prev, { id: `local-${Date.now()}`, kind: "user", text: trimmed }]);
      send({ type: "prompt", text: trimmed });
    },
    [send],
  );

  const interrupt = useCallback(() => send({ type: "interrupt" }), [send]);

  return { events, status, error, connected, sendPrompt, interrupt };
}
