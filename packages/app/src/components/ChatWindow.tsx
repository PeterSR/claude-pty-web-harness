import { useEffect, useRef, useState } from "react";
import type { ChatEvent, SessionStatus } from "@claude-pty-harness/protocol";
import { ChatMessage } from "./ChatMessage";

export function ChatWindow({
  events,
  status,
  connected,
  onSend,
  onInterrupt,
}: {
  events: ChatEvent[];
  status: SessionStatus;
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

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {events.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            {status === "ready" ? "Send a prompt to start." : "Waiting for Claude to start…"}
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
