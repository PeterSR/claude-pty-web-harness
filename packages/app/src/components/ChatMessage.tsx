import { useState } from "react";
import type { ChatEvent } from "@petersr/claude-pty-web-harness-protocol";

function Bubble({
  align,
  tone,
  label,
  children,
}: {
  align: "left" | "right";
  tone: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex ${align === "right" ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-2xl border px-4 py-2.5 ${tone}`}>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider opacity-60">{label}</div>
        {children}
      </div>
    </div>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{children}</pre>;
}

function fmtInput(input: unknown): string {
  try {
    const s = JSON.stringify(input, null, 2);
    return s && s.length > 600 ? s.slice(0, 600) + "\n…" : s ?? "";
  } catch {
    return String(input);
  }
}

export function ChatMessage({ event }: { event: ChatEvent }) {
  const [open, setOpen] = useState(false);

  switch (event.kind) {
    case "user":
      return (
        <Bubble align="right" label="You" tone="border-blue-500/30 bg-blue-500/15 text-blue-50">
          <Pre>{event.text}</Pre>
        </Bubble>
      );

    case "assistant_text":
      return (
        <Bubble align="left" label="Claude" tone="border-slate-600/40 bg-slate-700/30 text-slate-100">
          <Pre>{event.text}</Pre>
        </Bubble>
      );

    case "thinking":
      return (
        <div className="flex justify-start">
          <button
            onClick={() => setOpen((v) => !v)}
            className="max-w-[85%] rounded-2xl border border-purple-500/20 bg-purple-500/10 px-4 py-2 text-left"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-purple-300/70">
              Thinking {open ? "▾" : "▸"}
            </div>
            {open && <Pre>{event.text}</Pre>}
          </button>
        </div>
      );

    case "tool_use":
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/80">
              Tool · {event.name}
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-amber-100/90">
              {fmtInput(event.input)}
            </pre>
          </div>
        </div>
      );

    case "tool_result":
      return (
        <div className="flex justify-start">
          <div
            className={`max-w-[85%] rounded-2xl border px-4 py-2 ${
              event.isError ? "border-red-500/30 bg-red-500/10" : "border-emerald-500/20 bg-emerald-500/10"
            }`}
          >
            <div
              className={`text-[10px] font-semibold uppercase tracking-wider ${
                event.isError ? "text-red-300/80" : "text-emerald-300/80"
              }`}
            >
              {event.isError ? "Tool error" : "Tool result"}
            </div>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed opacity-90">
              {event.text || "(empty)"}
            </pre>
          </div>
        </div>
      );

    case "result":
      return (
        <div className="flex justify-center">
          <div className="rounded-full border border-slate-700 bg-slate-800/50 px-3 py-1 text-[11px] text-slate-400">
            turn complete
            {typeof event.durationMs === "number" ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ""}
            {typeof event.costUsd === "number" ? ` · $${event.costUsd.toFixed(4)}` : ""}
          </div>
        </div>
      );

    case "system":
      return null; // init / meta lines are not shown in the chat

    default:
      return null;
  }
}
