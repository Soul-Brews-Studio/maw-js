import { useState, useEffect, useRef, useCallback, memo } from "react";
import { ansiToHtml, processCapture } from "../lib/ansi";
import { agentColor, PREVIEW_CARD } from "../lib/constants";
import { apiUrl } from "../lib/api";
import type { AgentState, AgentEvent } from "../lib/types";

interface HoverPreviewCardProps {
  agent: AgentState;
  roomLabel: string;
  accent: string;
  pinned?: boolean;
  send?: (msg: object) => void;
  onFullscreen?: () => void;
  onClose?: () => void;
  eventLog?: AgentEvent[];
  addEvent?: (target: string, type: AgentEvent["type"], detail: string) => void;
  externalInputBuf?: string;
  onInputBufChange?: (val: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  busy: "#fdd835",
  ready: "#4caf50",
  idle: "#666",
};

const STATUS_LABELS: Record<string, string> = {
  busy: "BUSY",
  ready: "READY",
  idle: "IDLE",
};

// trimCapture replaced by shared processCapture from ansi.ts

export const HoverPreviewCard = memo(function HoverPreviewCard({
  agent,
  roomLabel,
  accent,
  pinned = false,
  send,
  onFullscreen,
  onClose,
  eventLog,
  addEvent,
  externalInputBuf,
  onInputBufChange,
}: HoverPreviewCardProps) {
  const [content, setContent] = useState("");
  const [localInputBuf, setLocalInputBuf] = useState("");
  const inputBuf = externalInputBuf ?? localInputBuf;
  const setInputBuf = useCallback((val: string) => {
    setLocalInputBuf(val);
    onInputBufChange?.(val);
  }, [onInputBufChange]);
  const termRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const color = agentColor(agent.name);
  const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
  const statusColor = STATUS_COLORS[agent.status] || "#666";

  // Sync prevInputRef when external buffer initializes
  useEffect(() => {
    if (externalInputBuf !== undefined) prevInputRef.current = externalInputBuf;
  }, []);

  // Auto-focus input when pinned (double-tap focus for mobile keyboard)
  useEffect(() => {
    if (pinned) {
      inputRef.current?.focus();
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.click();
      }, 50);
      return () => clearTimeout(t);
    }
  }, [pinned, agent.target]);

  // Slash streaming: track whether we're in streaming mode
  const streamingRef = useRef(false);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose?.(); return; }
    // F11 or Cmd+Enter for fullscreen
    if (e.key === "F11" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      onFullscreen?.();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (streamingRef.current) {
        // In streaming mode: just send Enter, chars already sent
        addEvent?.(agent.target, "command", inputBuf);
        send?.({ type: "send", target: agent.target, text: "\r" });
        streamingRef.current = false;
      } else if (inputBuf && send) {
        addEvent?.(agent.target, "command", inputBuf);
        send({ type: "send", target: agent.target, text: inputBuf });
      }
      setInputBuf("");
      prevInputRef.current = "";
      return;
    }
    // Backspace in streaming mode: send to tmux
    if (e.key === "Backspace" && streamingRef.current && send) {
      send({ type: "send", target: agent.target, text: "\b" });
      return; // let default input handling remove the char
    }
  }, [inputBuf, agent.target, send, onClose, onFullscreen]);

  // Track previous input value with ref (avoids stale closure)
  const prevInputRef = useRef("");

  // Stream chars to tmux when input starts with /
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const prev = prevInputRef.current;
    prevInputRef.current = val;
    setInputBuf(val);

    if (!send) return;

    // Entering slash mode: first / typed
    if (val === "/" && prev === "") {
      streamingRef.current = true;
      send({ type: "send", target: agent.target, text: "/" });
      return;
    }

    // In streaming mode: send new chars
    if (streamingRef.current && val.length > prev.length) {
      const newChars = val.slice(prev.length);
      for (const ch of newChars) {
        send({ type: "send", target: agent.target, text: ch });
      }
    }

    // Left streaming mode (user cleared or removed /)
    if (streamingRef.current && !val.startsWith("/")) {
      streamingRef.current = false;
    }
  }, [agent.target, send]);

  // Poll terminal capture
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const res = await fetch(apiUrl(`/api/capture?target=${encodeURIComponent(agent.target)}`));
        const data = await res.json();
        if (active) setContent(data.content || "");
      } catch {}
      if (active) setTimeout(poll, 500);
    }
    poll();
    return () => { active = false; };
  }, [agent.target]);

  // Auto-scroll to bottom — smooth when pinned, instant on hover
  const userScrolledRef = useRef(false);
  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    // If user scrolled up in pinned mode, don't force scroll
    if (pinned && userScrolledRef.current) return;
    if (pinned) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [content, pinned]);

  // Detect user scroll-up to pause auto-scroll (re-enable when near bottom)
  useEffect(() => {
    const el = termRef.current;
    if (!el || !pinned) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledRef.current = !nearBottom;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [pinned]);

  // Deterministic chibi features (same logic as AgentAvatar)
  let h = 0;
  for (let i = 0; i < agent.name.length; i++) h = ((h << 5) - h + agent.name.charCodeAt(i)) | 0;
  const hasEars = Math.abs(h) % 3 === 0;
  const hasAntenna = !hasEars && Math.abs(h) % 3 === 1;
  const eyeStyle = Math.abs(h >> 4) % 3;

  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-white/[0.08] shadow-2xl"
      style={{
        background: "#0a0a0f",
        width: PREVIEW_CARD.width,
        height: "calc(100vh - 120px)",
        maxHeight: PREVIEW_CARD.maxHeight,
      }}
      onMouseDown={(e) => {
        if (pinned && e.target !== inputRef.current) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {/* Header with big avatar */}
      <div
        className="relative flex flex-col items-center pt-6 pb-4 px-4"
        style={{
          background: `linear-gradient(180deg, ${accent}15 0%, transparent 100%)`,
          borderBottom: `1px solid ${accent}20`,
        }}
      >
        {/* Big chibi SVG avatar */}
        <svg width={100} height={90} viewBox="-40 -45 80 80">
          {/* Aura */}
          {agent.status === "busy" && (
            <>
              <circle cx={0} cy={-6} r={36} fill={statusColor} opacity={0.08}
                style={{ animation: "saiyan-aura 2s ease-in-out infinite" }} />
              <circle cx={0} cy={-6} r={42} fill="none" stroke={statusColor} strokeWidth={2}
                opacity={0.15} style={{ animation: "saiyan-outer 2s ease-in-out infinite" }} />
            </>
          )}
          {agent.status === "ready" && (
            <circle cx={0} cy={-6} r={28} fill={statusColor} opacity={0.08} />
          )}

          {/* Ground shadow */}
          <ellipse cx={0} cy={24} rx={16} ry={4}
            fill={agent.status === "idle" ? "#333" : statusColor}
            opacity={agent.status === "idle" ? 0.3 : 0.2} />

          {/* Body */}
          <rect x={-12} y={6} width={24} height={18} rx={8}
            fill={color} stroke="#fff" strokeWidth={1.5} opacity={0.9} />
          <rect x={-6} y={14} width={12} height={5} rx={2} fill="#000" opacity={0.12} />

          {/* Head */}
          <circle cx={0} cy={-10} r={20} fill={color} stroke="#fff" strokeWidth={2} />

          {/* Hair */}
          <ellipse cx={-4} cy={-28} rx={6} ry={4} fill={color} stroke="#fff" strokeWidth={1} />
          <ellipse cx={4} cy={-29} rx={5} ry={3} fill={color} stroke="#fff" strokeWidth={1} />

          {/* Cat ears */}
          {hasEars && (
            <>
              <polygon points="-14,-24 -18,-36 -6,-28" fill={color} stroke="#fff" strokeWidth={1.5} />
              <polygon points="14,-24 18,-36 6,-28" fill={color} stroke="#fff" strokeWidth={1.5} />
              <polygon points="-13,-25 -16,-33 -8,-27" fill="#ffb4b4" opacity={0.4} />
              <polygon points="13,-25 16,-33 8,-27" fill="#ffb4b4" opacity={0.4} />
            </>
          )}

          {/* Antenna */}
          {hasAntenna && (
            <>
              <line x1={0} y1={-30} x2={0} y2={-40} stroke="#888" strokeWidth={1.5} />
              <circle cx={0} cy={-42} r={3} fill={statusColor} />
            </>
          )}

          {/* Eyes */}
          {eyeStyle === 0 && (
            <>
              <circle cx={-7} cy={-12} r={4.5} fill="#fff" />
              <circle cx={7} cy={-12} r={4.5} fill="#fff" />
              <circle cx={-6} cy={-12} r={2.5} fill="#222" />
              <circle cx={8} cy={-12} r={2.5} fill="#222" />
              <circle cx={-5} cy={-13.5} r={1} fill="#fff" />
              <circle cx={9} cy={-13.5} r={1} fill="#fff" />
            </>
          )}
          {eyeStyle === 1 && (
            <>
              <path d="M -10 -12 Q -7 -15 -4 -12" fill="none" stroke="#222" strokeWidth={1.8} strokeLinecap="round" />
              <path d="M 4 -12 Q 7 -15 10 -12" fill="none" stroke="#222" strokeWidth={1.8} strokeLinecap="round" />
            </>
          )}
          {eyeStyle === 2 && (
            <>
              <circle cx={-7} cy={-12} r={4.5} fill="#fff" />
              <circle cx={7} cy={-12} r={4.5} fill="#fff" />
              <text x={-7} y={-9.5} textAnchor="middle" fill={color} fontSize={7} fontWeight="bold">*</text>
              <text x={7} y={-9.5} textAnchor="middle" fill={color} fontSize={7} fontWeight="bold">*</text>
            </>
          )}

          {/* Blush */}
          <ellipse cx={-12} cy={-7} rx={3} ry={2} fill="#ff9999" opacity={0.25} />
          <ellipse cx={12} cy={-7} rx={3} ry={2} fill="#ff9999" opacity={0.25} />

          {/* Mouth */}
          {agent.status === "busy" ? (
            <ellipse cx={0} cy={-4} rx={2.5} ry={2} fill="#333" />
          ) : (
            <path d="M -3 -5 Q 0 -2 3 -5" fill="none" stroke="#333" strokeWidth={1.2} strokeLinecap="round" />
          )}

          {/* Headphones */}
          <path d="M -17 -14 Q -18 -28 0 -30 Q 18 -28 17 -14" fill="none" stroke="#555" strokeWidth={2.5} />
          <rect x={-20} y={-18} width={6} height={10} rx={3} fill="#444" stroke="#555" strokeWidth={1} />
          <rect x={14} y={-18} width={6} height={10} rx={3} fill="#444" stroke="#555" strokeWidth={1} />
          <line x1={-19} y1={-10} x2={-14} y2={-2} stroke="#555" strokeWidth={1.2} />
          <circle cx={-13} cy={-1} r={1.5} fill="#666" />

          {/* Arms */}
          {agent.status === "busy" ? (
            <>
              <g style={{ animation: "typing-arm 0.25s ease-in-out infinite" }}>
                <line x1={-12} y1={10} x2={-22} y2={18} stroke={color} strokeWidth={3} strokeLinecap="round" />
              </g>
              <g style={{ animation: "typing-arm 0.25s ease-in-out 0.12s infinite" }}>
                <line x1={12} y1={10} x2={22} y2={18} stroke={color} strokeWidth={3} strokeLinecap="round" />
              </g>
            </>
          ) : (
            <>
              <line x1={-12} y1={10} x2={-16} y2={20} stroke={color} strokeWidth={3} strokeLinecap="round" />
              <line x1={12} y1={10} x2={16} y2={20} stroke={color} strokeWidth={3} strokeLinecap="round" />
            </>
          )}

          {/* Legs + shoes */}
          <line x1={-5} y1={23} x2={-6} y2={28} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
          <line x1={5} y1={23} x2={6} y2={28} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
          <ellipse cx={-7} cy={29} rx={3.5} ry={2} fill="#333" />
          <ellipse cx={7} cy={29} rx={3.5} ry={2} fill="#333" />
        </svg>

        {/* Name + status */}
        <h2
          className="mt-2 text-base font-bold tracking-[3px] uppercase"
          style={{ color: accent }}
        >
          {displayName}
        </h2>

        <div className="flex items-center gap-3 mt-1.5">
          <span className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: statusColor,
                boxShadow: agent.status !== "idle" ? `0 0 6px ${statusColor}` : undefined,
              }}
            />
            <span className="text-[10px] font-mono" style={{ color: statusColor }}>
              {STATUS_LABELS[agent.status]}
            </span>
          </span>
          <span className="text-[10px] text-white/40 font-mono">{roomLabel}</span>
        </div>

        <span className="mt-1 text-[9px] text-white/25 font-mono">{agent.target}</span>
      </div>

      {/* Event timeline badges — pinned only */}
      {pinned && eventLog && (() => {
        const events = eventLog.filter(e => e.target === agent.target).slice(-20);
        if (events.length === 0) return null;
        const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
          "status": { bg: "rgba(255,255,255,0.06)", text: "#aaa" },
          "command": { bg: "rgba(34,211,238,0.15)", text: "#22d3ee" },
        };
        return (
          <div className="flex flex-wrap gap-1 px-3 py-1.5 bg-white/[0.02] border-b border-white/[0.04] overflow-hidden max-h-[52px]">
            {events.map((ev, i) => {
              const badge = STATUS_BADGE[ev.type] || STATUS_BADGE.status;
              const t = new Date(ev.time);
              const ts = `${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}:${t.getSeconds().toString().padStart(2, "0")}`;
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono whitespace-nowrap"
                  style={{ background: badge.bg, color: badge.text }}
                  title={`${ts} — ${ev.detail}`}
                >
                  <span className="text-white/30">{ts.slice(3)}</span>
                  {ev.detail}
                </span>
              );
            })}
          </div>
        );
      })()}

      {/* Terminal header with fullscreen button */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white/[0.02] border-b border-white/[0.04]">
        <span className="text-[9px] text-white/30 tracking-[2px] uppercase font-mono">Live Terminal</span>
        <span
          className="w-1.5 h-1.5 rounded-full ml-auto"
          style={{
            background: "#4caf50",
            boxShadow: "0 0 4px #4caf50",
            animation: "agent-pulse 2s ease-in-out infinite",
          }}
        />
        {pinned && onFullscreen && (
          <button
            onClick={onFullscreen}
            className="ml-1 px-2 py-0.5 rounded text-[9px] text-white/40 hover:text-white/80 hover:bg-white/[0.06] cursor-pointer font-mono transition-colors"
            title="Fullscreen (Ctrl+Enter)"
          >
            ⛶
          </button>
        )}
        {pinned && onClose && (
          <button
            onClick={onClose}
            className="px-1.5 py-0.5 rounded text-[9px] text-white/30 hover:text-white/60 hover:bg-white/[0.06] cursor-pointer transition-colors"
            title="Close (Esc)"
          >
            ✕
          </button>
        )}
      </div>

      <div className="relative flex-1" style={{ background: "#08080c" }}>
        <div
          ref={termRef}
          className="absolute inset-0 px-3 py-2 overflow-y-auto overflow-x-hidden font-mono text-[10px] leading-[1.4] text-[#cdd6f4] whitespace-pre-wrap break-all"
          dangerouslySetInnerHTML={{ __html: ansiToHtml(processCapture(content)) }}
        />
        {pinned && send && (
          <div className="absolute bottom-3 right-3 flex flex-col gap-1 z-10">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); send({ type: "send", target: agent.target, text: "\x1b[A" }); inputRef.current?.focus(); }}
              className="w-9 h-8 rounded-lg bg-black/70 backdrop-blur border border-white/10 text-white/50 hover:text-white hover:bg-white/10 cursor-pointer flex items-center justify-center transition-colors"
              title="Up → tmux"
            >
              <svg width={12} height={8} viewBox="0 0 12 8"><path d="M1 7L6 1L11 7" stroke="currentColor" strokeWidth={1.5} fill="none" strokeLinecap="round" /></svg>
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); send({ type: "send", target: agent.target, text: "\x1b[B" }); inputRef.current?.focus(); }}
              className="w-9 h-8 rounded-lg bg-black/70 backdrop-blur border border-white/10 text-white/50 hover:text-white hover:bg-white/10 cursor-pointer flex items-center justify-center transition-colors"
              title="Down → tmux"
            >
              <svg width={12} height={8} viewBox="0 0 12 8"><path d="M1 1L6 7L11 1" stroke="currentColor" strokeWidth={1.5} fill="none" strokeLinecap="round" /></svg>
            </button>
          </div>
        )}
      </div>

      {/* Bottom: input when pinned, preview text when hovering */}
      {pinned && send ? (
        <div
          className="flex items-center gap-2 px-3 py-2 bg-[#0e0e18] border-t border-white/[0.06] font-mono text-xs cursor-text"
          onClick={() => inputRef.current?.focus()}
        >
          <span className="text-cyan-400 font-semibold shrink-0">&#x276f;</span>
          <input
            ref={inputRef}
            type="text"
            value={inputBuf}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-white/90 outline-none caret-cyan-400 font-mono text-xs [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
            style={{ caretColor: "#22d3ee", WebkitAppearance: "none" }}
            inputMode="text"
            enterKeyHint="send"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            placeholder="type command..."
          />
          {inputBuf && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setInputBuf("");
                prevInputRef.current = "";
                if (streamingRef.current) {
                  // Clear what was streamed to tmux
                  send?.({ type: "send", target: agent.target, text: "\x15" }); // Ctrl+U clears line
                  streamingRef.current = false;
                }
                inputRef.current?.focus();
              }}
              className="shrink-0 w-6 h-6 rounded-full bg-white/[0.06] text-white/30 hover:text-white/60 hover:bg-white/10 cursor-pointer flex items-center justify-center text-[10px] transition-colors"
              title="Clear"
            >
              ✕
            </button>
          )}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!send) return;
              if (streamingRef.current) {
                addEvent?.(agent.target, "command", inputBuf);
                send({ type: "send", target: agent.target, text: "\r" });
                streamingRef.current = false;
              } else if (inputBuf) {
                addEvent?.(agent.target, "command", inputBuf);
                send({ type: "send", target: agent.target, text: inputBuf });
              } else {
                send({ type: "send", target: agent.target, text: "\r" });
              }
              setInputBuf("");
              prevInputRef.current = "";
              inputRef.current?.focus();
            }}
            className="shrink-0 px-4 py-2 rounded-lg bg-cyan-500 text-black text-xs font-bold cursor-pointer hover:bg-cyan-400 active:bg-cyan-600 transition-colors shadow-lg shadow-cyan-500/20"
          >
            SEND
          </button>
        </div>
      ) : (
        <div className="px-3 py-2 bg-[#0e0e18] border-t border-white/[0.06] font-mono text-[9px] text-white/30 truncate">
          {agent.preview || "..."}
        </div>
      )}

      {/* Quick command shortcuts */}
      {pinned && send && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0a0a14] border-t border-white/[0.04] overflow-x-auto">
          {[
            { label: "y", text: "y\r", color: "#22C55E" },
            { label: "n", text: "n\r", color: "#ef5350" },
            { label: "↵", text: "\r", color: "#64748B" },
            { label: "Tab", text: "\t", color: "#a78bfa" },
            { label: "/recap", text: "/recap\r", color: "#fbbf24" },
            { label: "/help", text: "/help\r", color: "#42a5f5" },
            { label: "Ctrl+C", text: "\x03", color: "#ef5350" },
            { label: "Ctrl+Z", text: "\x1a", color: "#ffa726" },
            { label: "exit", text: "exit\r", color: "#94A3B8" },
          ].map(cmd => (
            <button
              key={cmd.label}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                send({ type: "send", target: agent.target, text: cmd.text });
                addEvent?.(agent.target, "command", cmd.label);
                inputRef.current?.focus();
              }}
              className="shrink-0 px-2.5 py-1 rounded-md text-[10px] font-mono cursor-pointer active:scale-90 transition-all"
              style={{ background: `${cmd.color}15`, color: cmd.color, border: `1px solid ${cmd.color}25` }}
            >
              {cmd.label}
            </button>
          ))}
        </div>
      )}

      {/* Shortcut hints — always visible when pinned */}
      {pinned && (
        <div className="flex items-center justify-center gap-3 px-3 py-1.5 bg-[#08080c] border-t border-white/[0.04] font-mono text-[8px] text-white/20">
          <span><kbd className="text-white/30">Enter</kbd> send</span>
          <span><kbd className="text-white/30">⌃Enter</kbd> fullscreen</span>
          <span><kbd className="text-white/30">Esc</kbd> close</span>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              send?.({ type: "send", target: agent.target, text: "\x1b" });
              inputRef.current?.focus();
            }}
            className="px-2 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-[9px] text-white/40 hover:text-white/80 hover:bg-white/10 cursor-pointer transition-colors"
          >
            Esc→tmux
          </button>
        </div>
      )}
    </div>
  );
});
