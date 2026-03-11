import { memo, useCallback, useRef, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { MiniMonitor } from "./MiniMonitor";
import type { AgentState } from "../lib/types";

const isTouch = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

interface AgentRowProps {
  agent: AgentState;
  accent: string;
  roomLabel: string;
  saiyan: boolean;
  isLast: boolean;
  agoLabel?: string;
  feedActivity?: string | null;
  observe: (el: HTMLElement | null, target: string) => void;
  showPreview: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
  hidePreview: () => void;
  onAgentClick: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
  send?: (msg: object) => void;
  onSendDone?: (agent: AgentState, accent: string, roomLabel: string) => void;
}

export const AgentRow = memo(function AgentRow({
  agent,
  accent,
  roomLabel,
  saiyan,
  isLast,
  agoLabel,
  feedActivity,
  observe,
  showPreview,
  hidePreview,
  onAgentClick,
  send,
  onSendDone,
}: AgentRowProps) {
  const isBusy = agent.status === "busy";
  const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
  const [inputOpen, setInputOpen] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleMic = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (inputOpen) {
      setInputOpen(false);
      return;
    }
    setInputOpen(true);
    // iOS: focus synchronously in tap handler to trigger keyboard
    inputRef.current?.focus();
  }, [inputOpen]);

  const handleSend = useCallback(() => {
    if (!text.trim() || !send) return;
    send({ type: "send", target: agent.target, text: text.trim() });
    setTimeout(() => send({ type: "send", target: agent.target, text: "\r" }), 50);
    setText("");
    setSent(true);
    setTimeout(() => {
      setSent(false);
      setInputOpen(false);
      onSendDone?.(agent, accent, roomLabel);
    }, 400);
  }, [text, agent.target, send, onSendDone, agent, accent, roomLabel]);

  return (
    <div ref={(el) => observe(el, agent.target)}>
      <div
        className="flex items-center gap-5 px-6 py-3.5 transition-all duration-150 cursor-pointer hover:bg-white/[0.03]"
        style={{
          borderBottom: !isLast && !inputOpen ? "1px solid rgba(255,255,255,0.04)" : "none",
          background: isBusy ? `${accent}06` : "transparent",
        }}
        onClick={(e) => onAgentClick(agent, accent, roomLabel, e)}
        role="button"
        tabIndex={0}
        aria-label={`${agent.name} - ${agent.status}`}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.preventDefault(); }}
      >
        {/* Avatar */}
        <div
          className="w-14 h-14 flex-shrink-0 cursor-pointer"
          style={{ overflow: "visible" }}
          onMouseEnter={isTouch ? undefined : (e) => showPreview(agent, accent, roomLabel, e)}
          onMouseLeave={isTouch ? undefined : () => hidePreview()}
        >
          <svg viewBox="-40 -50 80 80" width={56} height={56} overflow="visible">
            <AgentAvatar
              name={agent.name}
              target={agent.target}
              status={agent.status}
              preview={agent.preview}
              accent={accent}
              saiyan={saiyan}
              onClick={() => {}}
            />
          </svg>
        </div>

        {/* Mini monitor — hidden on touch (no hover to preview) */}
        {!isTouch && (
          <MiniMonitor
            target={agent.target}
            accent={accent}
            busy={isBusy}
            onMouseEnter={(e) => showPreview(agent, accent, roomLabel, e)}
            onMouseLeave={() => hidePreview()}
            onClick={(e) => onAgentClick(agent, accent, roomLabel, e)}
          />
        )}

        {/* Info column */}
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <span
              className="text-[15px] font-semibold truncate"
              style={{ color: isBusy ? accent : "#E2E8F0" }}
            >
              {displayName}
            </span>
            <span
              className="text-[11px] font-mono px-2.5 py-1 rounded-md flex-shrink-0"
              style={{
                background: isBusy ? "#ffa72620" : agent.status === "ready" ? "#22C55E18" : "rgba(255,255,255,0.06)",
                color: isBusy ? "#ffa726" : agent.status === "ready" ? "#22C55E" : "#94A3B8",
              }}
            >
              {agent.status}
            </span>
            {agoLabel && (
              <span className="text-[10px] font-mono text-white/25 flex-shrink-0">{agoLabel}</span>
            )}
            {saiyan && (
              <span className="text-[10px] font-mono px-2.5 py-1 rounded-md bg-amber-400/20 text-amber-400 flex-shrink-0">
                SAIYAN
              </span>
            )}
          </div>
          <span className="text-[13px] truncate" style={{ color: "#64748B" }}>
            {agent.preview?.slice(0, 80) || "\u00a0"}
          </span>
          {feedActivity && (
            <span className="text-[11px] truncate" style={{ color: "#fbbf24", opacity: 0.7 }}>
              {feedActivity}
            </span>
          )}
        </div>

        {/* Mic button */}
        {send && (
          <button
            className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer transition-all active:scale-90"
            style={{
              background: inputOpen ? accent : `${accent}20`,
              boxShadow: inputOpen ? `0 0 16px ${accent}80` : "none",
            }}
            onClick={handleMic}
            aria-label={`Talk to ${displayName}`}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none"
              stroke={inputOpen ? "#000" : accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x={9} y={1} width={6} height={11} rx={3} />
              <path d="M19 10v1a7 7 0 01-14 0v-1M12 18v4M8 22h8" />
            </svg>
          </button>
        )}
      </div>

      {/* Inline input — always in DOM for iOS keyboard sync focus */}
      <div
        className="flex items-center gap-2 px-6 overflow-hidden transition-all duration-200"
        style={{
          height: inputOpen ? 56 : 0,
          opacity: inputOpen ? 1 : 0,
          padding: inputOpen ? undefined : "0 24px",
          background: `${accent}08`,
          borderBottom: inputOpen && !isLast ? "1px solid rgba(255,255,255,0.04)" : "none",
        }}
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") handleSend(); if (e.key === "Escape") { setInputOpen(false); } }}
          onBlur={() => { if (!text.trim()) setTimeout(() => setInputOpen(false), 200); }}
          placeholder={`Talk to ${displayName}...`}
          className="flex-1 px-4 py-3 rounded-xl text-[15px] text-white outline-none placeholder:text-white/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
          style={{
            background: "rgba(255,255,255,0.06)",
            border: `1px solid ${accent}20`,
            WebkitAppearance: "none" as const,
          }}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          tabIndex={inputOpen ? 0 : -1}
        />
        {sent ? (
          <span className="text-[12px] font-mono px-3 py-2 rounded-lg" style={{ background: "#22C55E20", color: "#22C55E" }}>✓</span>
        ) : (
          <button
            className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 cursor-pointer active:scale-90"
            style={{
              background: text.trim() ? accent : `${accent}20`,
            }}
            onClick={handleSend}
            tabIndex={inputOpen ? 0 : -1}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none"
              stroke={text.trim() ? "#000" : `${accent}50`}
              strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});
