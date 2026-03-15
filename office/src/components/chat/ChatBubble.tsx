import { agentColor } from "../../lib/constants";
import { ChibiAvatar } from "./ChibiAvatar";
import { type MawLogEntry, formatTime, displayName, isHuman } from "./types";

// ─── Single Bubble (used inside groups) ───

export function BubbleContent({ entry, isRight, highlighted, onToggle, isFirst, isLast }: {
  entry: MawLogEntry; isRight: boolean; highlighted: boolean; onToggle: () => void;
  isFirst: boolean; isLast: boolean;
}) {
  const human = isHuman(entry.from);
  const color = human ? "#e8b86d" : agentColor(entry.from);
  const radius = isRight
    ? `${isFirst ? "18px" : "6px"} 4px ${isLast ? "18px" : "6px"} 18px`
    : `4px ${isFirst ? "18px" : "6px"} 18px ${isLast ? "18px" : "6px"}`;

  return (
    <div
      className="px-4 py-2.5 whitespace-pre-wrap break-words cursor-pointer transition-all duration-200"
      style={{
        fontSize: "14.5px",
        lineHeight: "1.7",
        borderRadius: radius,
        color: highlighted ? "#fff" : isRight ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.8)",
        background: highlighted
          ? `${color}38`
          : human
            ? "rgba(232,184,109,0.12)"
            : isRight
              ? `${color}28`
              : "rgba(255,255,255,0.06)",
        border: `1px solid ${
          highlighted
            ? `${color}70`
            : human
              ? "rgba(232,184,109,0.25)"
              : isRight
                ? `${color}40`
                : "rgba(255,255,255,0.10)"
        }`,
        boxShadow: highlighted ? `0 0 20px ${color}25` : "none",
      }}
      onClick={onToggle}
    >
      {entry.msg}
    </div>
  );
}

// ─── Grouped Chat Bubble (avatar + name once, stacked bubbles) ───

export function ChatGroup({ entries, isRight, highlighted, onToggleHighlight, idPrefix }: {
  entries: MawLogEntry[]; isRight: boolean;
  highlighted: string | null; onToggleHighlight: (id: string) => void;
  idPrefix: string;
}) {
  const sender = entries[0].from;
  const human = isHuman(sender);
  const color = human ? "#e8b86d" : agentColor(sender);
  const name = displayName(sender);

  return (
    <div
      className={`flex gap-2.5 ${isRight ? "flex-row-reverse" : ""}`}
      style={{ maxWidth: "82%" }}
    >
      <ChibiAvatar name={sender} size={36} />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className={`flex items-baseline gap-2 mb-0.5 ${isRight ? "flex-row-reverse" : ""}`}>
          <span className="text-[13px] font-bold capitalize" style={{ color }}>{name}</span>
          {human ? (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(232,184,109,0.15)", color: "#e8b86d" }}>Human</span>
          ) : (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(100,181,246,0.10)", color: "rgba(100,181,246,0.5)" }}>AI</span>
          )}
          <span className="text-[10px] text-white/15 font-mono">{formatTime(entries[0].ts)}</span>
          {entries.length > 1 && (
            <span className="text-[9px] text-white/10 font-mono">×{entries.length}</span>
          )}
        </div>
        {entries.map((entry, i) => {
          const id = `${idPrefix}-${i}`;
          return (
            <BubbleContent
              key={id}
              entry={entry}
              isRight={isRight}
              highlighted={highlighted === id}
              onToggle={() => onToggleHighlight(id)}
              isFirst={i === 0}
              isLast={i === entries.length - 1}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Single bubble with avatar (for ThreadCard) ───

export function ChatBubbleSingle({ entry, isRight, highlighted, onToggle }: {
  entry: MawLogEntry; isRight: boolean; highlighted: boolean; onToggle: () => void;
}) {
  const color = agentColor(entry.from);
  const name = displayName(entry.from);

  return (
    <div
      className={`flex gap-2.5 cursor-pointer transition-all duration-200 ${isRight ? "flex-row-reverse" : ""}`}
      style={{ maxWidth: "80%" }}
      onClick={onToggle}
    >
      <ChibiAvatar name={entry.from} size={36} />
      <div className="min-w-0 flex-1">
        <div className={`flex items-baseline gap-2 mb-1 ${isRight ? "flex-row-reverse" : ""}`}>
          <span className="text-[13px] font-bold capitalize" style={{ color }}>{name}</span>
          <span className="text-[10px] text-white/15 font-mono">{formatTime(entry.ts)}</span>
        </div>
        <BubbleContent entry={entry} isRight={isRight} highlighted={highlighted} onToggle={onToggle} isFirst isLast />
      </div>
    </div>
  );
}

// ─── Date Separator ───

export function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-3 my-5">
      <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
      <span className="text-[10px] font-mono text-white/20 tracking-wider">{date}</span>
      <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
    </div>
  );
}
