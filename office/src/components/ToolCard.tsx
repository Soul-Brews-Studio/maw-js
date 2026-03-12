import { memo } from "react";
import type { FeedEvent } from "../lib/feed";
import { describeActivity } from "../lib/feed";

interface ToolCardProps {
  event: FeedEvent;
  accent: string;
}

export const ToolCard = memo(function ToolCard({ event, accent }: ToolCardProps) {
  const ago = Math.round((Date.now() - event.ts) / 1000);
  const agoStr = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;
  const desc = describeActivity(event);

  return (
    <div
      className="flex items-center gap-2 px-3 py-2.5 rounded-lg font-mono text-[12px]"
      style={{
        background: `${accent}0a`,
        borderLeft: `3px solid ${accent}`,
        animation: "toolCardIn 150ms ease-out",
      }}
    >
      <span className="flex-1 truncate" style={{ color: "#cdd6f4" }}>
        {desc}
      </span>
      <span className="flex-shrink-0 text-[10px]" style={{ color: "rgba(255,255,255,0.2)" }}>
        {agoStr}
      </span>
    </div>
  );
});
