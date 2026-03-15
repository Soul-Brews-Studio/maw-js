import { useState } from "react";
import { agentColor } from "../../lib/constants";
import { ChibiAvatar } from "./ChibiAvatar";
import { ChatBubbleSingle } from "./ChatBubble";
import { type MawLogEntry, displayName } from "./types";

export function ThreadCard({ pair, entries, viewAs, defaultExpanded, highlighted, onToggleHighlight }: {
  pair: string; entries: MawLogEntry[]; viewAs: string; defaultExpanded: boolean;
  highlighted: string | null; onToggleHighlight: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [a, b] = pair.split("↔");
  const lastEntry = entries[entries.length - 1];
  const shown = expanded ? entries : entries.slice(-2);

  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
    >
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center -space-x-2">
          <ChibiAvatar name={a} size={28} />
          <ChibiAvatar name={b} size={28} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-bold capitalize" style={{ color: agentColor(a) }}>{displayName(a)}</span>
            <span className="text-[10px] text-white/15">&</span>
            <span className="text-[12px] font-bold capitalize" style={{ color: agentColor(b) }}>{displayName(b)}</span>
            <span className="text-[10px] text-white/20 font-mono ml-1">{entries.length}</span>
          </div>
          <p className="text-[11px] text-white/25 truncate mt-0.5">
            {displayName(lastEntry.from)}: {(lastEntry.msg || "").slice(0, 60)}
          </p>
        </div>
        <span className="text-white/15 text-[10px]">{expanded ? "▼" : "▶"}</span>
      </button>

      {(expanded || entries.length <= 2) && (
        <div className="px-3 pb-3 flex flex-col gap-2.5">
          {!expanded && entries.length > 2 && (
            <button
              className="text-center py-1 text-[10px] font-mono text-white/15 hover:text-white/30"
              onClick={() => setExpanded(true)}
            >
              ··· {entries.length - 2} earlier ···
            </button>
          )}
          {shown.map((entry, i) => {
            const id = `${entry.ts}-${i}`;
            return (
              <ChatBubbleSingle
                key={id}
                entry={entry}
                isRight={entry.from === viewAs}
                highlighted={highlighted === id}
                onToggle={() => onToggleHighlight(id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
