import { memo, useState, useEffect, useRef } from "react";
import { ansiToHtml, processCapture } from "../lib/ansi";
import { apiUrl } from "../lib/api";

interface MiniMonitorProps {
  target: string;
  accent: string;
  busy: boolean;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
  onClick: (e: React.MouseEvent) => void;
}

/** Simple string hash — fast, good enough for diff detection */
function quickHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Tiny terminal "monitor" — shows real ANSI capture at minimap scale.
 * Only polls when busy — idle agents show a frozen last frame.
 * Detects activity via content hash diff.
 */
export const MiniMonitor = memo(function MiniMonitor({
  target,
  accent,
  busy,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: MiniMonitorProps) {
  const [content, setContent] = useState("");
  const [activity, setActivity] = useState<"active" | "stale" | "idle">("idle");
  const ref = useRef<HTMLDivElement>(null);
  const prevHashRef = useRef<number>(0);
  const staleCountRef = useRef(0);
  const [hovered, setHovered] = useState(false);

  // Poll only when server says busy or user is hovering
  // busy → 0.5s fast stream
  // hovered → 1s
  // idle → no polling, frozen frame
  const shouldPoll = busy || hovered;
  const pollInterval = busy ? 500 : 1000;

  // When busy stops, immediately transition activity down
  useEffect(() => {
    if (!busy) {
      setActivity((prev) => prev === "active" ? "stale" : prev);
      const t = setTimeout(() => setActivity("idle"), 3000);
      return () => clearTimeout(t);
    }
  }, [busy]);

  useEffect(() => {
    if (!shouldPoll) return;

    let active = true;
    async function poll() {
      try {
        const res = await fetch(apiUrl(`/api/capture?target=${encodeURIComponent(target)}`));
        const data = await res.json();
        const text = data.content || "";
        if (!active) return;

        const hash = quickHash(text);
        if (prevHashRef.current !== 0 && hash !== prevHashRef.current) {
          // Content actually changing — only show active if server agrees busy
          setActivity(busy ? "active" : "stale");
          staleCountRef.current = 0;
        } else if (prevHashRef.current !== 0) {
          staleCountRef.current++;
          if (staleCountRef.current >= 3) {
            setActivity("idle");
          } else {
            setActivity("stale");
          }
        }
        prevHashRef.current = hash;
        setContent(text);
      } catch {}
      if (active) setTimeout(poll, pollInterval);
    }
    poll();
    return () => { active = false; };
  }, [target, shouldPoll, pollInterval, busy]);

  // Fetch one frame on mount so idle agents aren't blank
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    fetch(apiUrl(`/api/capture?target=${encodeURIComponent(target)}`))
      .then(r => r.json())
      .then(data => {
        const text = data.content || "";
        prevHashRef.current = quickHash(text);
        setContent(text);
      })
      .catch(() => {});
  }, [target]);

  // Keep scrolled to bottom
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [content]);

  const html = ansiToHtml(processCapture(content));

  const isActive = activity === "active";
  const isStale = activity === "stale";
  const borderColor = isActive
    ? `${accent}80`
    : isStale
      ? `${accent}30`
      : "rgba(255,255,255,0.08)";
  const glowShadow = isActive
    ? `0 0 16px ${accent}30, inset 0 0 8px ${accent}10`
    : isStale
      ? `0 0 6px ${accent}10`
      : "none";

  return (
    <div
      className="flex-shrink-0 rounded-lg overflow-hidden cursor-pointer border transition-all duration-500 group relative"
      style={{
        width: 140,
        height: 90,
        background: "#08080c",
        borderColor,
        boxShadow: glowShadow,
      }}
      onMouseEnter={(e) => { setHovered(true); onMouseEnter(e); }}
      onMouseLeave={() => { setHovered(false); onMouseLeave(); }}
      onClick={onClick}
    >
      {/* Activity LED — top-right dot */}
      <div
        className="absolute top-[3px] right-[3px] z-20 rounded-full transition-all duration-500"
        style={{
          width: 5,
          height: 5,
          background: isActive ? "#4caf50" : isStale ? "#ffa726" : "#333",
          boxShadow: isActive
            ? "0 0 6px #4caf50, 0 0 2px #4caf50"
            : isStale
              ? "0 0 4px #ffa726"
              : "none",
          animation: isActive ? "agent-pulse 1s ease-in-out infinite" : "none",
        }}
      />

      {/* Scanline overlay for CRT feel */}
      <div
        className="absolute inset-0 pointer-events-none z-10 rounded-lg"
        style={{
          background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 3px)",
          mixBlendMode: "multiply",
        }}
      />

      {/* Hover glow */}
      <div
        className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10"
        style={{
          boxShadow: `inset 0 0 12px ${accent}20, 0 0 8px ${accent}15`,
        }}
      />

      {/* ANSI content at minimap scale */}
      <div
        ref={ref}
        className="w-full h-full px-[3px] py-[2px] overflow-hidden font-mono whitespace-pre-wrap"
        style={{
          fontSize: "3.5px",
          lineHeight: 1.3,
          wordBreak: "break-all",
          color: "#cdd6f4",
          opacity: activity === "idle" ? 0.5 : 1,
          transition: "opacity 0.5s",
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {/* Subtle screen reflection */}
      <div
        className="absolute top-0 left-0 right-0 h-[40%] pointer-events-none z-10 rounded-t-lg"
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%)",
        }}
      />
    </div>
  );
});
