import { useState, useEffect, useRef, useCallback } from "react";
import { ansiToHtml } from "../lib/ansi";
import type { AgentState } from "../lib/types";

function trimCapture(raw: string): string {
  const lines = raw.split("\n");
  while (lines.length > 0) {
    const stripped = lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (stripped === "") lines.pop();
    else break;
  }
  return lines.join("\n");
}

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
  busy: "#ffa726",
  ready: "#4caf50",
  idle: "#555",
};

export function TerminalModal({ agent, send, onClose, onNavigate, onSelectSibling, siblings }: TerminalModalProps) {
  const [content, setContent] = useState("");
  const [inputBuf, setInputBuf] = useState("");
  const termRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input on open + when switching agents
  useEffect(() => {
    // Small delay to ensure DOM is ready
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [agent.target]);

  // Refocus input when clicking anywhere in the modal
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const refocus = () => { setTimeout(() => inputRef.current?.focus(), 0); };
    el.addEventListener("mousedown", refocus);
    return () => el.removeEventListener("mousedown", refocus);
  }, []);

  useEffect(() => {
    send({ type: "subscribe", target: agent.target });
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/capture?target=${encodeURIComponent(agent.target)}`);
        const data = await res.json();
        setContent(data.content || "");
      } catch {}
    }, 200);
    return () => { clearInterval(poll); send({ type: "subscribe", target: "" }); };
  }, [agent.target, send]);

  const isFirstContent = useRef(true);
  useEffect(() => {
    const el = termRef.current;
    if (el) {
      // Always scroll to bottom on first content load
      if (isFirstContent.current && content) {
        isFirstContent.current = false;
        el.scrollTop = el.scrollHeight;
      } else {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
    }
  }, [content]);

  // Reset first-content flag when switching agents
  useEffect(() => {
    isFirstContent.current = true;
  }, [agent.target]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    // Alt+Arrow to navigate between agents in same room
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); onNavigate(-1); return; }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); onNavigate(1); return; }
    // Alt+1-9 to jump to sibling by index
    if (e.altKey && e.key >= "1" && e.key <= "9") {
      const idx = parseInt(e.key) - 1;
      if (idx < siblings.length) { e.preventDefault(); onSelectSibling(siblings[idx]); }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (inputBuf) { send({ type: "send", target: agent.target, text: inputBuf }); setInputBuf(""); }
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault(); setInputBuf("");
    }
  }, [inputBuf, agent.target, send, onClose, onNavigate]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (text) setInputBuf((b) => b + text);
  }, []);

  const displayName = cleanName(agent.name);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      ref={wrapperRef}
    >
      <div className="w-[90vw] max-w-[900px] h-[80vh] bg-[#0a0a0f] border border-white/[0.06] rounded-xl flex flex-col overflow-hidden shadow-2xl">
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

          <div className="ml-auto flex items-center gap-3 shrink-0">
            {siblings.length > 1 && (
              <span className="text-[9px] text-white/20 tracking-wider">Alt+1-{Math.min(9, siblings.length)}</span>
            )}
            <button onClick={onClose} className="text-white/20 hover:text-white/50 text-lg cursor-pointer">
              &times;
            </button>
          </div>
        </div>

        {/* Terminal output */}
        <div
          ref={termRef}
          className="flex-1 px-4 py-3 overflow-y-auto font-mono text-[13px] leading-[1.35] text-[#aaa] whitespace-pre-wrap break-all bg-[#0a0a0f] saturate-[0.55] brightness-[1.15] contrast-[0.95]"
          dangerouslySetInnerHTML={{ __html: ansiToHtml(trimCapture(content)) }}
        />

        {/* Input */}
        <div
          className="flex items-center gap-2 px-4 py-2 bg-[#0e0e18] border-t border-white/[0.06] font-mono text-xs cursor-text"
          onClick={() => inputRef.current?.focus()}
        >
          <span className="text-cyan-400 font-semibold shrink-0">&#x276f;</span>
          <div className="relative flex-1 min-h-[20px]">
            <input
              ref={inputRef}
              type="text"
              value={inputBuf}
              onChange={(e) => setInputBuf(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              className="absolute inset-0 w-full bg-transparent text-white/90 outline-none caret-cyan-400 font-mono text-xs"
              style={{ caretColor: "#22d3ee" }}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </div>
        </div>
      </div>
    </div>
  );
}
