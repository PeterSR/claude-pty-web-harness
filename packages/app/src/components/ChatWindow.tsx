import { useEffect, useRef, useState } from "react";
import type { ChatEvent, SessionStatus } from "@petersr/claude-pty-web-harness-protocol";
import { ChatMessage } from "./ChatMessage";

// Turn a machine failure reason (a StartupFailure) into a human sentence.
const FAILURE_MESSAGES: Record<string, string> = {
  auth_blocked: "Claude could not authenticate. Run `claude` once in a terminal to log in, then retry.",
  rate_limit: "Claude hit a usage limit before it could start. Wait and try again.",
  workspace_trust_blocked: "Claude's trust prompt for this folder was not accepted.",
  tool_approval_blocked: "Claude is waiting on a tool-permission prompt it could not clear.",
  custom_api_key_detected: "Claude paused on a custom-API-key prompt. Unset ANTHROPIC_API_KEY or accept it.",
  startup_timeout: "Claude never reached its input prompt in time.",
};

export function ChatWindow({
  events,
  status,
  error,
  connected,
  onSend,
  onInterrupt,
}: {
  events: ChatEvent[];
  status: SessionStatus;
  error?: string | null;
  connected: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  const submit = () => {
    if (!text.trim() || status !== "ready") return;
    onSend(text);
    setText("");
  };

  const failed = status === "failed";
  const failureText = failed ? FAILURE_MESSAGES[error ?? "startup_timeout"] ?? `Startup failed (${error}).` : null;

  return (
    <div className="flex h-full flex-col">
      {failed && (
        <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-2 text-sm text-red-300">
          <span className="font-medium">Session failed to start.</span> {failureText}
        </div>
      )}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {events.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            {status === "ready"
              ? "Send a prompt to start."
              : failed
                ? failureText
                : "Waiting for Claude to start…"}
          </div>
        )}
        {events.map((e) => (
          <ChatMessage key={e.id} event={e} />
        ))}
      </div>

      <div className="border-t border-slate-800 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={status === "ready" ? "Message Claude…  (Enter to send, Shift+Enter for newline)" : "Starting…"}
            rows={2}
            className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-slate-500"
          />
          <button
            onClick={status === "ready" ? submit : onInterrupt}
            disabled={!connected}
            className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
          >
            {status === "ready" ? "Send" : "Stop"}
          </button>
        </div>
      </div>
    </div>
  );
}
