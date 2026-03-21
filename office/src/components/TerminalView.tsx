import { memo, useState, useEffect, useRef, useCallback } from "react";
import { ansiToHtml } from "../lib/ansi";
import { roomStyle } from "../lib/constants";
import { wsUrl } from "../lib/api";
import type { Session, AgentState } from "../lib/types";

interface TerminalViewProps {
  sessions: Session[];
  agents: AgentState[];
  connected: boolean;
  onSelectAgent: (agent: AgentState) => void;
}

export const TerminalView = memo(function TerminalView({ sessions, agents, connected, onSelectAgent }: TerminalViewProps) {
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [captureHtml, setCaptureHtml] = useState("");
  const [inputBuf, setInputBuf] = useState("");
  const [sendQueue, setSendQueue] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

  // Own WebSocket for capture stream (separate from main fleet WS)
  useEffect(() => {
    const ws = new WebSocket(wsUrl("/ws"));
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "capture") {
          const out = outputRef.current;
          const atBottom = out ? out.scrollHeight - out.scrollTop - out.clientHeight < 60 : true;
          setCaptureHtml(ansiToHtml(data.content || "(empty)"));
          if (atBottom) requestAnimationFrame(() => out?.scrollTo(0, out.scrollHeight));
        }
      } catch {}
    };

    ws.onclose = () => { wsRef.current = null; };
    ws.onerror = () => ws.close();

    return () => { ws.close(); wsRef.current = null; };
  }, []);

  // Subscribe when target changes
  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && selectedTarget) {
      ws.send(JSON.stringify({ type: "subscribe", target: selectedTarget }));
      ws.send(JSON.stringify({ type: "select", target: selectedTarget }));
    }
  }, [selectedTarget]);

  // Re-subscribe when WS reconnects
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const handler = () => {
      if (selectedTarget) ws.send(JSON.stringify({ type: "subscribe", target: selectedTarget }));
    };
    ws.addEventListener("open", handler);
    return () => ws.removeEventListener("open", handler);
  }, [selectedTarget]);

  const selectWindow = useCallback((target: string) => {
    setSelectedTarget(target);
    setCaptureHtml("");
    setInputBuf("");
    setSendQueue([]);
    termRef.current?.focus();
  }, []);

  // Flush send queue
  useEffect(() => {
    if (sendingRef.current || sendQueue.length === 0) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !selectedTarget) return;

    sendingRef.current = true;
    const text = sendQueue[0];
    ws.send(JSON.stringify({ type: "send", target: selectedTarget, text, force: true }));
    setTimeout(() => {
      setSendQueue(q => q.slice(1));
      sendingRef.current = false;
    }, 100);
  }, [sendQueue, selectedTarget]);

  const queueSend = useCallback((text: string) => {
    if (!text || !selectedTarget) return;
    setSendQueue(q => [...q, text]);
  }, [selectedTarget]);

  // Paste handler — fires on right-click paste or Ctrl+Shift+V
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (text) setInputBuf(b => b + text);
  }, []);

  // Keyboard handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Alt+Arrow to navigate between windows
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      if (!selectedTarget) return;
      const allWindows = sessions.flatMap(s => s.windows.map(w => ({ target: `${s.name}:${w.index}`, name: w.name })));
      const idx = allWindows.findIndex(w => w.target === selectedTarget);
      if (idx < 0) return;
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      const next = allWindows[(idx + dir + allWindows.length) % allWindows.length];
      selectWindow(next.target);
      return;
    }

    if (!selectedTarget) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        // Shift+Enter → newline in buffer
        setInputBuf(b => b + "\n");
      } else {
        // Enter → send
        if (inputBuf) { queueSend(inputBuf); setInputBuf(""); }
      }
    } else if (e.key === "Backspace") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) setInputBuf("");
      else setInputBuf(b => b.slice(0, -1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setInputBuf(""); setSendQueue([]);
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      setInputBuf(""); setSendQueue([]);
    } else if ((e.key === "v" && e.ctrlKey) || (e.key === "v" && e.metaKey)) {
      // Ctrl+V / Cmd+V → paste from clipboard
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        if (text) setInputBuf(b => b + text);
      }).catch(() => {});
    } else if (e.key === "Tab") {
      e.preventDefault();
      queueSend(inputBuf + "\t");
      setInputBuf("");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setInputBuf(b => b + e.key);
    }
  }, [selectedTarget, inputBuf, queueSend, selectWindow, sessions]);

  // Get display name for selected target
  const selectedName = selectedTarget
    ? sessions.flatMap(s => s.windows.map(w => ({ target: `${s.name}:${w.index}`, name: w.name }))).find(w => w.target === selectedTarget)?.name || ""
    : "";

  return (
    <div className="flex mx-4 sm:mx-6 mb-3 rounded-2xl overflow-hidden border border-white/[0.06]" style={{ height: "calc(100vh - 72px)" }}>
      {/* Sidebar */}
      <div className="w-[220px] flex-shrink-0 flex flex-col border-r border-white/[0.06] overflow-y-auto" style={{ background: "#08080e" }}>
        {sessions.map(session => {
          const style = roomStyle(session.name);
          return (
            <div key={session.name} className="py-1">
              <div className="px-4 py-1 text-[10px] uppercase tracking-[1px]" style={{ color: style.accent + "80" }}>
                {session.name}
              </div>
              {session.windows.map(w => {
                const target = `${session.name}:${w.index}`;
                const isSelected = target === selectedTarget;
                const agent = agents.find(a => a.target === target);
                const statusColor = agent?.status === "busy" ? "#ffa726" : agent?.status === "ready" ? "#4caf50" : "#333";
                return (
                  <div
                    key={target}
                    className="flex items-center gap-2 py-1.5 cursor-pointer transition-colors"
                    style={{
                      paddingLeft: 12, paddingRight: 12,
                      background: isSelected ? `${style.accent}12` : "transparent",
                      borderLeft: isSelected ? `3px solid ${style.accent}` : "3px solid transparent",
                    }}
                    onClick={() => selectWindow(target)}
                  >
                    <span className="text-[11px] font-mono text-white/30 w-4 text-right flex-shrink-0">{w.index}</span>
                    <span className="text-[12px] font-mono truncate" style={{ color: isSelected ? style.accent : "#999" }}>
                      {w.name}
                    </span>
                    <span
                      className="w-1.5 h-1.5 rounded-full ml-auto flex-shrink-0"
                      style={{ background: statusColor, boxShadow: w.active ? `0 0 4px ${statusColor}` : undefined }}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Terminal pane */}
      <div
        ref={termRef}
        className="flex-1 flex flex-col min-w-0 outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onClick={() => termRef.current?.focus()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.06] flex-shrink-0" style={{ background: "#0a0a12" }}>
          <span className="text-xs font-mono text-white/40">{selectedName || "select a window"}</span>
          {selectedTarget && <span className="text-[10px] font-mono text-white/20">{selectedTarget}</span>}
          <span className="ml-auto text-[10px] font-mono" style={{ color: connected ? "#4caf50" : "#ef5350" }}>
            {connected ? "live" : "reconnecting"}
          </span>
        </div>

        {/* Output */}
        <div
          ref={outputRef}
          className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-[1.35]"
          style={{ background: "#0a0a0f", whiteSpace: "pre", wordBreak: "normal", overflowX: "auto", color: "#aaa" }}
        >
          {captureHtml ? (
            <div dangerouslySetInnerHTML={{ __html: captureHtml }} />
          ) : (
            <div className="text-white/15 text-center mt-[30vh] text-sm">
              {selectedTarget ? "connecting..." : "select a window \u2190"}
            </div>
          )}
        </div>

        {/* Input line */}
        <div
          className="flex items-start px-3 py-1.5 border-t border-white/[0.06] font-mono text-[13px] min-h-[32px]"
          style={{ background: "#0d0d14" }}
        >
          <span className="text-white/30 mr-2 mt-[1px] flex-shrink-0">&gt;</span>
          <span className="text-white/90 whitespace-pre flex-1">{inputBuf}</span>
          <span
            className="inline-block w-[7px] h-[15px] ml-[1px] flex-shrink-0"
            style={{ background: selectedTarget ? "#89b4fa" : "#333", animation: "blink 1s step-end infinite", marginTop: "2px" }}
          />
          {sendQueue.length > 0 && (
            <span className="text-white/30 text-[11px] ml-2">({sendQueue.length} queued)</span>
          )}
          {(inputBuf || sendQueue.length > 0) && (
            <span
              className="ml-auto text-white/30 text-[11px] cursor-pointer hover:text-red-400 px-2 rounded"
              onClick={() => { setInputBuf(""); setSendQueue([]); }}
            >
              esc
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
