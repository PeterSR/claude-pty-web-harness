import { useEffect, useMemo, useState } from "react";
import { ChatWindow } from "./components/ChatWindow";
import { useHarnessSession, createHarnessClient } from "@petersr/claude-pty-web-harness-react";
import type { SessionSummary } from "@petersr/claude-pty-web-harness-protocol";

const DEFAULT_CWD = "";
const MODELS = ["", "sonnet", "opus", "haiku"];

function StatusDot({ status }: { status: SessionSummary["status"] }) {
  const color = status === "ready" ? "bg-emerald-400" : status === "starting" ? "bg-amber-400" : "bg-slate-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cwd, setCwd] = useState(DEFAULT_CWD);
  const [model, setModel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same-origin: REST is relative and the WS uses location.origin (Vite proxy).
  const client = useMemo(() => createHarnessClient(), []);

  const refresh = () => client.listSessions().then(setSessions).catch(() => {});
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useHarnessSession(activeId);

  const onCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const s = await client.createSession(cwd, model || undefined);
      await refresh();
      setActiveId(s.id);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setCreating(false);
    }
  };

  const onKill = async (id: string) => {
    await client.killSession(id);
    if (activeId === id) setActiveId(null);
    refresh();
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-80 flex-col border-r border-slate-800 bg-[#0e1117]">
        <div className="border-b border-slate-800 p-4">
          <h1 className="text-sm font-semibold text-slate-200">Claude PTY Harness</h1>
          <p className="mt-0.5 text-xs text-slate-500">Drive Claude Code over a pty, stream its JSONL.</p>
        </div>

        <div className="space-y-2 border-b border-slate-800 p-4">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-slate-500">Working dir</label>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/your/project"
            className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-slate-500"
          />
          <div className="flex items-center gap-2">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-slate-500"
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m || "default model"}
                </option>
              ))}
            </select>
            <button
              onClick={onCreate}
              disabled={creating || !cwd.trim()}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
            >
              {creating ? "Starting…" : "New session"}
            </button>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 && <p className="p-3 text-xs text-slate-600">No sessions yet.</p>}
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={`group mb-1 cursor-pointer rounded-lg border px-3 py-2 ${
                activeId === s.id ? "border-blue-500/40 bg-blue-500/10" : "border-transparent hover:bg-slate-800/50"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusDot status={s.status} />
                  <span className="font-mono text-xs text-slate-300">{s.id.slice(0, 8)}</span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onKill(s.id);
                  }}
                  className="text-xs text-slate-600 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                >
                  kill
                </button>
              </div>
              <div className="mt-1 truncate text-[11px] text-slate-500">{s.cwd}</div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1">
        {activeId ? (
          <ChatWindow
            events={active.events}
            status={active.status}
            connected={active.connected}
            onSend={active.sendPrompt}
            onInterrupt={active.interrupt}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-600">
            Create or select a session to start chatting.
          </div>
        )}
      </main>
    </div>
  );
}
