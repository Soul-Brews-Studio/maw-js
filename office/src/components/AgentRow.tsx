import { memo, useCallback, useRef, useState, useEffect } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { MiniMonitor } from "./MiniMonitor";
import type { AgentState } from "../lib/types";
import type { FeedLogEntry } from "./FleetGrid";
import { guessCommand } from "../lib/constants";

const isTouch = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

const RUNNING_EVENTS = new Set(["PreToolUse", "SubagentStart", "UserPromptSubmit"]);

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

/** Live ticking timer for running tool calls */
function ElapsedTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span style={{ color: "#fbbf24" }}>{formatElapsed(now - since)}</span>;
}

// --- Sub-components ---

function AgentControls({ agent, displayName, accent, inputOpen, send, onMic }: {
  agent: AgentState; displayName: string; accent: string;
  inputOpen: boolean; send: (msg: object) => void; onMic: (e: React.MouseEvent) => void;
}) {
  const isBusy = agent.status === "busy";
  const isIdle = agent.status === "idle";
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {/* Busy → pause (interrupt), Idle → play (wake), Ready → nothing */}
      {isBusy && (
        <button
          className="w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all active:scale-90"
          style={{ background: "rgba(251,191,36,0.12)" }}
          onClick={(e) => { e.stopPropagation(); send({ type: "sleep", target: agent.target }); }}
          title="Sleep (Ctrl+C)" aria-label={`Sleep ${displayName}`}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="#fbbf24">
            <rect x={6} y={5} width={4} height={14} rx={1} /><rect x={14} y={5} width={4} height={14} rx={1} />
          </svg>
        </button>
      )}
      {isIdle && (
        <button
          className="w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all active:scale-90"
          style={{ background: "rgba(34,197,94,0.12)" }}
          onClick={(e) => { e.stopPropagation(); send({ type: "wake", target: agent.target, command: guessCommand(agent.name) }); }}
          title="Wake (restart)" aria-label={`Wake ${displayName}`}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="#22c55e"><polygon points="8,5 19,12 8,19" /></svg>
        </button>
      )}
      <button
        className="w-10 h-10 rounded-full flex items-center justify-center cursor-pointer transition-all active:scale-90"
        style={{ background: inputOpen ? accent : `${accent}20`, boxShadow: inputOpen ? `0 0 16px ${accent}80` : "none" }}
        onClick={onMic} aria-label={`Talk to ${displayName}`}
      >
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none"
          stroke={inputOpen ? "#000" : accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x={9} y={1} width={6} height={11} rx={3} /><path d="M19 10v1a7 7 0 01-14 0v-1M12 18v4M8 22h8" />
        </svg>
      </button>
    </div>
  );
}

function AgentInfo({ agent, isBusy, displayName, accent, agoLabel, feedLog }: {
  agent: AgentState; isBusy: boolean; displayName: string; accent: string;
  agoLabel?: string; feedLog?: FeedLogEntry[] | null;
}) {
  return (
    <div className="flex flex-col gap-1 flex-1 min-w-0">
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-semibold truncate" style={{ color: isBusy ? accent : "#E2E8F0" }}>
          {displayName}
        </span>
        <span className="text-[11px] font-mono px-2.5 py-1 rounded-md flex-shrink-0" style={{
          background: isBusy ? "#ffa72620" : agent.status === "ready" ? "#22C55E18" : "rgba(255,255,255,0.06)",
          color: isBusy ? "#ffa726" : agent.status === "ready" ? "#22C55E" : "#94A3B8",
        }}>
          {agent.status}
        </span>
        {feedLog && feedLog.length > 0 && feedLog[0].project && (() => {
          const p = feedLog[0].project!;
          const wtMatch = p.match(/[.-]wt-(?:\d+-)?(.+)$/);
          if (wtMatch) {
            return (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
                style={{ background: "rgba(168,85,247,0.15)", color: "#c084fc" }}>
                wt:{wtMatch[1]}
              </span>
            );
          }
          return (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
              style={{ background: "rgba(99,102,241,0.12)", color: "#818cf8" }}>
              {p}
            </span>
          );
        })()}
        {agoLabel && <span className="text-[10px] font-mono text-white/25 flex-shrink-0">{agoLabel}</span>}
        {/* Last activity reason — shows what triggered busy status */}
        {!isBusy && feedLog && feedLog.length > 0 && (
          <span className="text-[10px] font-mono truncate max-w-[200px] flex-shrink" style={{ color: "#64748B" }}>
            {feedLog[0].text}
          </span>
        )}
      </div>
      {agent.preview && (
        <span className="text-[13px] truncate" style={{ color: "#64748B" }}>
          {agent.preview.slice(0, 80)}
        </span>
      )}
      {feedLog && feedLog.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {feedLog.slice(0, 3).map((entry, i) => {
            const isRunning = i === 0 && entry.eventType && RUNNING_EVENTS.has(entry.eventType);
            const ago = Math.round((Date.now() - entry.ts) / 1000);
            const agoStr = ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`;
            return (
              <span key={i} className="text-[10px] truncate font-mono"
                style={{ color: "#fbbf24", opacity: i === 0 ? 0.8 : 0.4 - i * 0.1 }}>
                {entry.text}
                {isRunning
                  ? <>{" "}<ElapsedTimer since={entry.ts} /></>
                  : <span style={{ color: "rgba(255,255,255,0.12)" }}> {agoStr}</span>
                }
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentInput({ accent, displayName, isLast, inputOpen, text, setText, sent, onSend, inputRef }: {
  accent: string; displayName: string; isLast: boolean; inputOpen: boolean;
  text: string; setText: (v: string) => void; sent: boolean; onSend: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      className="flex items-center gap-2 px-6 overflow-hidden transition-all duration-200"
      style={{
        height: inputOpen ? 56 : 0, opacity: inputOpen ? 1 : 0,
        padding: inputOpen ? undefined : "0 24px",
        background: `${accent}08`,
        borderBottom: inputOpen && !isLast ? "1px solid rgba(255,255,255,0.04)" : "none",
      }}
      onClick={e => e.stopPropagation()}
    >
      <input
        ref={inputRef} type="text" value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") onSend(); if (e.key === "Escape") setText("__close__"); }}
        onBlur={() => { if (!text.trim()) setTimeout(() => setText("__close__"), 200); }}
        placeholder={`Talk to ${displayName}...`}
        className="flex-1 px-4 py-3 rounded-xl text-[15px] text-white outline-none placeholder:text-white/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
        style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${accent}20`, WebkitAppearance: "none" as const }}
        enterKeyHint="send" autoComplete="off" autoCorrect="off" tabIndex={inputOpen ? 0 : -1}
      />
      {sent ? (
        <span className="text-[12px] font-mono px-3 py-2 rounded-lg" style={{ background: "#22C55E20", color: "#22C55E" }}>✓</span>
      ) : (
        <button
          className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 cursor-pointer active:scale-90"
          style={{ background: text.trim() ? accent : `${accent}20` }}
          onClick={onSend} tabIndex={inputOpen ? 0 : -1}
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none"
            stroke={text.trim() ? "#000" : `${accent}50`} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}

// --- Main component ---

interface AgentRowProps {
  agent: AgentState;
  accent: string;
  roomLabel: string;
  isLast: boolean;
  agoLabel?: string;
  featured?: boolean;
  feedLog?: FeedLogEntry[] | null;
  slept?: boolean;
  alignWidth?: number;
  observe: (el: HTMLElement | null, target: string) => void;
  showPreview: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
  hidePreview: () => void;
  onAgentClick: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
  send?: (msg: object) => void;
  onSendDone?: (agent: AgentState, accent: string, roomLabel: string) => void;
}

export const AgentRow = memo(function AgentRow({
  agent, accent, roomLabel, isLast, agoLabel, featured,
  feedLog, slept, alignWidth, observe, showPreview, hidePreview, onAgentClick, send, onSendDone,
}: AgentRowProps) {
  const isBusy = agent.status === "busy";
  const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
  const [inputOpen, setInputOpen] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleMic = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (inputOpen) { setInputOpen(false); return; }
    setInputOpen(true);
    inputRef.current?.focus();
  }, [inputOpen]);

  const handleSend = useCallback(() => {
    if (!text.trim() || !send) return;
    send({ type: "send", target: agent.target, text: text.trim() });
    setTimeout(() => send({ type: "send", target: agent.target, text: "\r" }), 50);
    setText("");
    setSent(true);
    setTimeout(() => { setSent(false); setInputOpen(false); onSendDone?.(agent, accent, roomLabel); }, 400);
  }, [text, agent.target, send, onSendDone, agent, accent, roomLabel]);

  // Handle close signal from AgentInput
  const setTextOrClose = useCallback((v: string) => {
    if (v === "__close__") { setInputOpen(false); setText(""); }
    else setText(v);
  }, []);

  // Slept: compact greyed-out row
  if (slept) {
    return (
      <div ref={(el) => observe(el, agent.target)}>
        <div
          className="flex items-center gap-4 px-6 py-2 transition-all duration-300 cursor-pointer hover:bg-white/[0.03]"
          style={{ borderBottom: !isLast ? "1px solid rgba(255,255,255,0.03)" : "none", opacity: 0.35 }}
          onClick={(e) => onAgentClick(agent, accent, roomLabel, e)}
          role="button" tabIndex={0} aria-label={`${agent.name} - sleeping`}
        >
          <div className="flex-shrink-0" style={{ width: 28, height: 28 }}>
            <svg viewBox="-40 -50 80 80" width={28} height={28} overflow="visible" style={{ filter: "grayscale(1)" }}>
              <AgentAvatar name={agent.name} target={agent.target} status="idle" preview="" accent="#666" onClick={() => {}} />
            </svg>
          </div>
          <span className="text-[13px] font-medium text-white/40 truncate flex-1">{displayName}</span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-md" style={{ background: "rgba(255,255,255,0.04)", color: "#64748B" }}>sleeping</span>
          {send && (
            <button
              className="w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all active:scale-90"
              style={{ background: "rgba(34,197,94,0.15)", opacity: 1 }}
              onClick={(e) => { e.stopPropagation(); send({ type: "wake", target: agent.target, command: guessCommand(agent.name) }); }}
              title="Wake" aria-label={`Wake ${displayName}`}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="#22c55e"><polygon points="8,5 19,12 8,19" /></svg>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={(el) => observe(el, agent.target)}>
      <div
        className="flex items-center gap-5 px-6 py-3.5 transition-all duration-150 cursor-pointer hover:bg-white/[0.03]"
        style={{
          borderBottom: !isLast && !inputOpen ? "1px solid rgba(255,255,255,0.04)" : "none",
          background: isBusy ? `${accent}06` : "transparent",
        }}
        onClick={(e) => onAgentClick(agent, accent, roomLabel, e)}
        role="button" tabIndex={0} aria-label={`${agent.name} - ${agent.status}`}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.preventDefault(); }}
      >
        {/* Avatar */}
        <div
          className="flex-shrink-0 cursor-pointer flex items-center justify-center"
          style={{
            overflow: "visible",
            width: alignWidth || (featured ? 96 : 56), height: featured ? 96 : 56,
            transition: "width 0.3s, height 0.3s",
          }}
          onMouseEnter={isTouch ? undefined : (e) => showPreview(agent, accent, roomLabel, e)}
          onMouseLeave={isTouch ? undefined : () => hidePreview()}
        >
          <svg viewBox="-40 -50 80 80" width={featured ? 96 : 56} height={featured ? 96 : 56} overflow="visible">
            <AgentAvatar name={agent.name} target={agent.target} status={agent.status} preview={agent.preview} accent={accent} activity={feedLog?.[0]?.text} onClick={() => {}} />
          </svg>
        </div>

        {!isTouch && (
          <div className="-ml-3">
            <MiniMonitor target={agent.target} accent={accent} busy={isBusy}
              onMouseEnter={(e) => showPreview(agent, accent, roomLabel, e)}
              onMouseLeave={() => hidePreview()}
              onClick={(e) => onAgentClick(agent, accent, roomLabel, e)} />
          </div>
        )}

        <AgentInfo agent={agent} isBusy={isBusy} displayName={displayName} accent={accent}
          agoLabel={agoLabel} feedLog={feedLog} />

        {send && <AgentControls agent={agent} displayName={displayName} accent={accent}
          inputOpen={inputOpen} send={send} onMic={handleMic} />}
      </div>

      <AgentInput accent={accent} displayName={displayName} isLast={isLast} inputOpen={inputOpen}
        text={text} setText={setTextOrClose} sent={sent} onSend={handleSend} inputRef={inputRef} />
    </div>
  );
});
