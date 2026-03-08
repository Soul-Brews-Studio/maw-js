import { memo } from "react";

interface StatusBarProps {
  connected: boolean;
  agentCount: number;
  sessionCount: number;
}

export const StatusBar = memo(function StatusBar({ connected, agentCount, sessionCount }: StatusBarProps) {
  return (
    <header className="sticky top-0 z-20 flex items-center gap-4 mx-6 mt-4 px-6 py-3 rounded-2xl bg-black/50 backdrop-blur-xl border border-white/[0.06] shadow-[0_4px_30px_rgba(0,0,0,0.4)]">
      <h1 className="text-lg font-bold tracking-[6px] text-cyan-400 uppercase">
        Oracle Office
      </h1>
      <span className="text-[10px] text-white/25 tracking-[3px] hidden sm:inline">
        multi-agent workflow orchestra
      </span>

      <div className="ml-auto flex items-center gap-4 text-[11px] text-white/50">
        <span className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_6px_#4caf50]" : "bg-red-400 animate-pulse"}`} />
          {connected ? "LIVE" : "RECONNECTING"}
        </span>
        <span><strong className="text-cyan-400">{agentCount}</strong> agents</span>
        <span><strong className="text-purple-400">{sessionCount}</strong> rooms</span>
        <a href="#mission" className="text-white/25 hover:text-white/60 transition-colors">Mission</a>
        <a href="/" className="text-white/25 hover:text-white/60 transition-colors">Terminal</a>
        <a href="/dashboard" className="text-white/25 hover:text-white/60 transition-colors">Orbital</a>
      </div>
    </header>
  );
});
