import { lazy, Suspense } from "react";
import type { AgentState } from "../lib/types";

const XTerminal = lazy(() => import("./XTerminal").then(m => ({ default: m.XTerminal })));

interface TerminalModalProps {
  agent: AgentState;
  send: (msg: object) => void;
  onClose: () => void;
  onNavigate: (dir: -1 | 1) => void;
  onSelectSibling: (agent: AgentState) => void;
  siblings: AgentState[];
}

function cleanName(name: string) {
  return name.replace(/-oracle$/, "").replace(/-/g, " ");
}

const STATUS_DOT: Record<string, string> = {
  busy: "#fdd835",
  ready: "#4caf50",
  idle: "#666",
};

export function TerminalModal({ agent, send, onClose, onNavigate, onSelectSibling, siblings }: TerminalModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0f]">
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2 bg-[#0e0e18] border-b border-white/[0.06]">
          <div className="flex gap-1.5 shrink-0">
            <button onClick={onClose} className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-110 cursor-pointer" />
            <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          </div>

          {/* Agent tab bar */}
          <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none mx-2">
            {siblings.map((s, i) => {
              const active = s.target === agent.target;
              return (
                <button
                  key={s.target}
                  onClick={() => onSelectSibling(s)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono whitespace-nowrap cursor-pointer transition-all ${
                    active
                      ? "bg-white/10 text-white/90"
                      : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"
                  }`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: STATUS_DOT[s.status] || "#555" }}
                  />
                  {i < 9 && (
                    <span className="text-[9px] text-white/20">{i + 1}</span>
                  )}
                  {cleanName(s.name)}
                </button>
              );
            })}
          </div>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            <button
              onClick={() => { if (confirm(`Restart ${agent.name}?`)) send({ type: "restart", target: agent.target }); }}
              className="px-2 py-0.5 rounded text-[10px] font-mono text-white/30 hover:text-orange-400 hover:bg-orange-400/10 border border-transparent hover:border-orange-400/20 transition-all cursor-pointer"
              title="Restart agent (Ctrl+C → relaunch)"
            >
              restart
            </button>
            {siblings.length > 1 && (
              <span className="text-[9px] text-white/20 tracking-wider">Alt+1-{Math.min(9, siblings.length)}</span>
            )}
            <button onClick={onClose} className="w-10 h-10 rounded-xl flex items-center justify-center text-2xl font-bold text-white/30 hover:text-white/70 hover:bg-red-500/15 active:scale-90 cursor-pointer transition-all" title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* Terminal — xterm.js via PTY WebSocket */}
        <div className="flex-1 overflow-hidden">
          <Suspense fallback={
            <div className="flex items-center justify-center h-full text-white/30 text-sm font-mono">
              Loading terminal...
            </div>
          }>
            <XTerminal
              target={agent.target}
              onClose={onClose}
              onNavigate={onNavigate}
              siblings={siblings}
              onSelectSibling={onSelectSibling}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
