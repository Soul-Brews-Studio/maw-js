import { memo, useState, useEffect, useRef, useCallback } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { agentColor } from "../lib/constants";
import { ansiToHtml, processCapture } from "../lib/ansi";
import { apiUrl } from "../lib/api";
import type { AgentState } from "../lib/types";

interface VSAgentPanelProps {
  agent: AgentState | null;
  send: (msg: object) => void;
  onPickAgent: () => void;
}

export const VSAgentPanel = memo(function VSAgentPanel({ agent, send, onPickAgent }: VSAgentPanelProps) {
  const [content, setContent] = useState("");
  const [inputBuf, setInputBuf] = useState("");
  const termRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isFirstContent = useRef(true);

  // Poll terminal content
  useEffect(() => {
    if (!agent) return;
    setContent("");
    isFirstContent.current = true;
    send({ type: "subscribe", target: agent.target });
    const poll = setInterval(async () => {
      try {
        const res = await fetch(apiUrl(`/api/capture?target=${encodeURIComponent(agent.target)}`));
        const data = await res.json();
        setContent(data.content || "");
      } catch {}
    }, 300);
    return () => clearInterval(poll);
  }, [agent?.target, send]);

  // Auto-scroll
  useEffect(() => {
    const el = termRef.current;
    if (el) {
      if (isFirstContent.current && content) {
        isFirstContent.current = false;
        el.scrollTop = el.scrollHeight;
      } else {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
    }
  }, [content]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (inputBuf && agent) {
        send({ type: "send", target: agent.target, text: inputBuf });
        setInputBuf("");
      }
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      setInputBuf("");
    }
  }, [inputBuf, agent, send]);

  const accent = agent ? agentColor(agent.name) : "#666";
  const displayName = agent ? agent.name.replace(/-oracle$/, "").replace(/-/g, " ") : "—";
  const status = agent?.status || "idle";

  // Empty state
  if (!agent) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 min-w-0" style={{ background: "#0a0a12" }}>
        <button
          onClick={onPickAgent}
          className="px-6 py-3 rounded-xl text-[14px] font-mono cursor-pointer transition-all active:scale-95"
          style={{ background: "rgba(34,211,238,0.12)", color: "#22d3ee", border: "1px solid rgba(34,211,238,0.2)" }}
        >
          Pick Agent
        </button>
        <span className="text-[12px] font-mono text-white/20">Select an oracle to watch</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0" style={{ background: "#0a0a12" }}>
      {/* Header: chibi + name + pick button */}
      <div
        className="flex items-center gap-3 px-3 py-2 border-b cursor-pointer hover:bg-white/[0.02] transition-colors"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
        onClick={onPickAgent}
      >
        <div style={{ width: 36, height: 36 }} className="flex-shrink-0">
          <svg viewBox="-40 -50 80 80" width={36} height={36} overflow="visible">
            <AgentAvatar
              name={agent.name}
              target={agent.target}
              status={status}
              preview=""
              accent={accent}
              onClick={() => {}}
            />
          </svg>
        </div>
        <span className="text-[14px] font-semibold font-mono truncate" style={{ color: accent }}>
          {displayName}
        </span>
        <span
          className="text-[10px] font-mono px-2 py-0.5 rounded-md flex-shrink-0"
          style={{
            background: status === "busy" ? "#ffa72620" : status === "ready" ? "#22C55E18" : "rgba(255,255,255,0.06)",
            color: status === "busy" ? "#ffa726" : status === "ready" ? "#22C55E" : "#94A3B8",
          }}
        >
          {status}
        </span>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth={2} className="ml-auto flex-shrink-0">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      {/* Terminal output */}
      <div
        ref={termRef}
        className="flex-1 px-3 py-2 overflow-y-auto font-mono text-[12px] leading-[1.35] text-[#cdd6f4] whitespace-pre-wrap break-all"
        style={{ background: "#08080e" }}
        dangerouslySetInnerHTML={{ __html: ansiToHtml(processCapture(content)) }}
      />

      {/* Input */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 border-t font-mono text-[11px] cursor-text"
        style={{ background: "#0e0e18", borderColor: "rgba(255,255,255,0.06)" }}
        onClick={() => inputRef.current?.focus()}
      >
        <span style={{ color: accent }} className="font-semibold shrink-0">&#x276f;</span>
        <input
          ref={inputRef}
          type="text"
          value={inputBuf}
          onChange={(e) => setInputBuf(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent text-white/90 outline-none font-mono text-[11px] [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
          style={{ caretColor: accent, WebkitAppearance: "none" as const }}
          spellCheck={false}
          autoComplete="off"
          placeholder="Type command..."
        />
      </div>
    </div>
  );
});
