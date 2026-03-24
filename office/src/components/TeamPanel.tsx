import { memo, useState, useEffect } from "react";
import { apiUrl } from "../lib/api";

interface TeamMember {
  name: string;
  color: string | null;
  backendType: string | null;
  isActive: boolean | null;
  tmuxPaneId: string;
  model: string;
}

interface Team {
  name: string;
  description: string;
  members: TeamMember[];
}

interface Task {
  id: string;
  subject: string;
  status: string;
  owner: string | null;
}

const COLOR_MAP: Record<string, string> = {
  blue: "#60a5fa",
  green: "#4ade80",
  red: "#f87171",
  yellow: "#facc15",
  purple: "#c084fc",
  cyan: "#22d3ee",
  orange: "#fb923c",
};

export const TeamPanel = memo(function TeamPanel() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [tasks, setTasks] = useState<Record<string, Task[]>>({});

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(apiUrl("/api/teams"));
        const data = await res.json();
        setTeams(data.teams || []);
        for (const t of data.teams || []) {
          const tr = await fetch(apiUrl(`/api/teams/${t.name}/tasks`));
          const td = await tr.json();
          setTasks(prev => ({ ...prev, [t.name]: td.tasks || [] }));
        }
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 10000);
    return () => clearInterval(iv);
  }, []);

  if (teams.length === 0) {
    return (
      <div className="p-6 text-center text-white/30 font-mono text-sm">
        No active teams. Use <span className="text-cyan-400">TeamCreate</span> to start one.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 120px)" }}>
      {teams.map(team => {
        const teamTasks = tasks[team.name] || [];
        const done = teamTasks.filter(t => t.status === "completed").length;
        const total = teamTasks.length;
        return (
          <div key={team.name} className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-3">
              <span className="text-sm font-bold tracking-[2px] uppercase text-cyan-400">{team.name}</span>
              <span className="text-[10px] text-white/30 font-mono ml-auto">{team.members.length} members</span>
              {total > 0 && (
                <span className="text-[10px] font-mono" style={{ color: done === total ? "#4ade80" : "#facc15" }}>
                  {done}/{total} tasks
                </span>
              )}
            </div>
            {team.description && (
              <div className="px-4 py-1.5 text-[10px] text-white/40 font-mono">{team.description}</div>
            )}
            <div className="px-4 py-2 flex flex-wrap gap-2">
              {team.members.map(m => {
                const color = COLOR_MAP[m.color || ""] || "#888";
                return (
                  <div key={m.name} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                    <span className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
                    <span className="text-[11px] font-mono text-white/80">{m.name}</span>
                    {m.backendType === "tmux" && (
                      <span className="text-[8px] text-white/20 font-mono">{m.tmuxPaneId}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {teamTasks.length > 0 && (
              <div className="px-4 py-2 border-t border-white/[0.04] flex flex-col gap-1">
                {teamTasks.map(t => (
                  <div key={t.id} className="flex items-center gap-2 text-[10px] font-mono">
                    <span>{t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜"}</span>
                    <span className={t.status === "completed" ? "text-white/30 line-through" : "text-white/70"}>{t.subject}</span>
                    {t.owner && <span className="text-white/20 ml-auto">@{t.owner}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
