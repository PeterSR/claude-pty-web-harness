// Headless hook that owns the WebSocket to a harness session: collects the
// transcript, tracks status, exposes sendPrompt / interrupt. No UI; render the
// returned `events` however you like.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createHarnessClient } from "./api";
import type { ChatEvent, ClientMessage, ServerMessage, SessionStatus } from "@claude-pty-harness/protocol";

export interface UseHarnessSessionOptions {
  /** Harness server origin. Empty = same-origin (e.g. behind a dev proxy). */
  baseUrl?: string;
}

export interface HarnessSession {
  events: ChatEvent[];
  status: SessionStatus;
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
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    setStatus("starting");

    const ws = new WebSocket(client.streamUrl(sessionId));
    wsRef.current = ws;
    const seen = new Set<string>();

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "status") {
        setStatus(msg.status);
      } else if (msg.type === "chat") {
        if (seen.has(msg.event.id)) return;
        seen.add(msg.event.id);
        const event = msg.event;
        setEvents((prev) => {
          // Drop the optimistic local echo once the real JSONL user entry lands.
          if (event.kind === "user") {
            const filtered = prev.filter((e) => !(e.id.startsWith("local-") && e.kind === "user" && e.text === event.text));
            return [...filtered, event];
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

  return { events, status, connected, sendPrompt, interrupt };
}
