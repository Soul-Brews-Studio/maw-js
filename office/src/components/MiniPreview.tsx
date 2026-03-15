import { useState, useEffect, useRef, memo } from "react";
import { ansiToHtml, processCapture } from "../lib/ansi";
import { apiUrl } from "../lib/api";

interface MiniPreviewProps {
  agent: { target: string; name: string; status: string };
  accent: string;
  roomLabel: string;
}

const STATUS_COLORS: Record<string, string> = {
  busy: "#fdd835",
  ready: "#4caf50",
  idle: "#666",
};

export const MiniPreview = memo(function MiniPreview({ agent, accent, roomLabel }: MiniPreviewProps) {
  const [content, setContent] = useState("");
  const termRef = useRef<HTMLDivElement>(null);
  const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
  const statusColor = STATUS_COLORS[agent.status] || "#666";

  useEffect(() => {
    let active = true;
    fetch(apiUrl(`/api/capture?target=${encodeURIComponent(agent.target)}`))
      .then(r => r.json())
      .then(d => { if (active) setContent(d.content || ""); })
      .catch(() => {});
    return () => { active = false; };
  }, [agent.target]);

  // Scroll to bottom when content loads
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [content]);

  return (
    <div
      className="rounded-lg border border-white/[0.08] shadow-xl overflow-hidden"
      style={{ background: "#0a0a0f", width: 320 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${accent}20` }}>
        <span className="text-[12px] font-bold tracking-[2px] uppercase" style={{ color: accent }}>
          {displayName}
        </span>
        <span className="flex items-center gap-1 ml-auto">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
          <span className="text-[9px] font-mono uppercase" style={{ color: statusColor }}>
            {agent.status}
          </span>
        </span>
        <span className="text-[9px] text-white/25 font-mono">{roomLabel}</span>
      </div>

      {/* Terminal snippet — 8 lines max */}
      <div
        ref={termRef}
        className="px-2.5 py-2 font-mono text-[9px] leading-[1.35] text-[#cdd6f4] whitespace-pre-wrap break-all overflow-y-auto"
        style={{ maxHeight: 120, background: "#08080c" }}
        dangerouslySetInnerHTML={{ __html: ansiToHtml(processCapture(content)) }}
      />

      {/* Click hint */}
      <div className="px-2.5 py-1 text-[8px] font-mono text-white/15 text-center" style={{ background: "#0a0a0f", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
        click to open
      </div>
    </div>
  );
});
