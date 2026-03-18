import { memo, type ReactNode } from "react";

interface StatusBarProps {
  connected: boolean;
  agentCount: number;
  sessionCount: number;
  activeView?: string;
  onJump?: () => void;
  muted?: boolean;
  onToggleMute?: () => void;
  children?: ReactNode;
}

interface NavItem {
  href: string;
  label: string;
  id: string;
  external?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/office/#office", label: "Office", id: "office" },
  { href: "/office/#fleet", label: "Fleet", id: "fleet" },
  { href: "/office/#mission", label: "Mission", id: "mission" },
  { href: "/office/#vs", label: "VS", id: "vs" },
  { href: "/office/#overview", label: "Overview", id: "overview" },
  { href: "/office/#config", label: "Config", id: "config" },
  { href: "http://localhost:3456/", label: "Terminal", id: "terminal", external: true },
  { href: "/dashboard", label: "Orbital", id: "orbital" },
];

const isTouch = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

export const StatusBar = memo(function StatusBar({ connected, agentCount, sessionCount, activeView = "office", onJump, muted, onToggleMute, children }: StatusBarProps) {
  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 mx-4 sm:mx-6 mt-3 px-4 sm:px-6 py-2.5 rounded-2xl bg-black/50 backdrop-blur-xl border border-white/[0.06] shadow-[0_4px_30px_rgba(0,0,0,0.4)]">
      <h1 className="text-base sm:text-lg font-bold tracking-[4px] sm:tracking-[6px] text-cyan-400 uppercase whitespace-nowrap">
        {activeView === "fleet" ? "Oracle Fleet" : activeView === "mission" ? "Oracle Mission" : activeView === "overview" ? "Oracle Overview" : activeView === "vs" ? "Oracle VS" : activeView === "config" ? "Oracle Config" : "Oracle Office"}
      </h1>

      <span className="flex items-center gap-1.5 text-sm text-white/70">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-emerald-400 shadow-[0_0_6px_#4caf50]" : "bg-red-400 animate-pulse"}`} />
        {connected ? "LIVE" : "..."}
      </span>

      <span className="text-sm text-white/70 whitespace-nowrap">
        <strong className="text-cyan-400">{agentCount}</strong> agents
      </span>
      <span className="text-sm text-white/70 whitespace-nowrap">
        <strong className="text-purple-400">{sessionCount}</strong> rooms
      </span>
      <span className="text-[10px] text-white/20 font-mono whitespace-nowrap">
        v{__MAW_VERSION__} · {__MAW_BUILD__}
      </span>

      {/* View-specific controls injected by parent */}
      {children}

      {onToggleMute && (
        <button
          onClick={onToggleMute}
          className="px-2.5 py-1.5 rounded-lg text-xs font-mono active:scale-95 transition-all whitespace-nowrap"
          style={{
            background: muted ? "rgba(239,83,80,0.15)" : "rgba(76,175,80,0.15)",
            color: muted ? "#ef5350" : "#4caf50",
            border: `1px solid ${muted ? "rgba(239,83,80,0.25)" : "rgba(76,175,80,0.25)"}`,
          }}
          title={muted ? "Unmute sounds" : "Mute sounds"}
        >
          {muted ? "🔇" : "🔊"}
        </button>
      )}

      {isTouch && onJump && (
        <button
          onClick={onJump}
          className="px-3 py-1.5 rounded-lg text-xs font-mono font-bold active:scale-95 transition-all whitespace-nowrap"
          style={{ background: "rgba(34,211,238,0.15)", color: "#22d3ee", border: "1px solid rgba(34,211,238,0.25)" }}
          title="Jump to agent (⌘J)"
        >
          ⌘J
        </button>
      )}

      <nav className={`${isTouch && onJump ? "" : "ml-auto "}flex items-center gap-3 sm:gap-4 text-sm`}>
        {NAV_ITEMS.map((item) => (
          <a
            key={item.id}
            href={item.href}
            target={item.external ? "_blank" : undefined}
            rel={item.external ? "noopener noreferrer" : undefined}
            className={`transition-colors whitespace-nowrap ${
              activeView === item.id
                ? "text-cyan-400 font-bold"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </header>
  );
});
