import { useState, useEffect, useCallback } from "react";

interface WorktreeInfo {
  path: string;
  branch: string;
  repo: string;
  mainRepo: string;
  name: string;
  status: "active" | "stale" | "orphan";
  tmuxWindow?: string;
  fleetFile?: string;
}

const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  active: { bg: "bg-green-900/40", text: "text-green-400", label: "Active" },
  stale: { bg: "bg-yellow-900/40", text: "text-yellow-400", label: "Stale" },
  orphan: { bg: "bg-red-900/40", text: "text-red-400", label: "Orphan" },
};

export function WorktreeView() {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cleaning, setCleaning] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<Record<string, string[]>>({});

  const fetchWorktrees = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/worktrees");
      const data = await res.json();
      if (Array.isArray(data)) {
        setWorktrees(data);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchWorktrees(); }, [fetchWorktrees]);

  const cleanup = useCallback(async (wt: WorktreeInfo) => {
    setCleaning((prev) => new Set(prev).add(wt.path));
    try {
      const res = await fetch("/api/worktrees/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: wt.path }),
      });
      const data = await res.json();
      if (data.ok) {
        setLogs((prev) => ({ ...prev, [wt.path]: data.log }));
        // Refresh after cleanup
        setTimeout(fetchWorktrees, 500);
      } else {
        setLogs((prev) => ({ ...prev, [wt.path]: [`Error: ${data.error}`] }));
      }
    } catch (e: any) {
      setLogs((prev) => ({ ...prev, [wt.path]: [`Error: ${e.message}`] }));
    }
    setCleaning((prev) => {
      const next = new Set(prev);
      next.delete(wt.path);
      return next;
    });
  }, [fetchWorktrees]);

  const cleanupAll = useCallback(async () => {
    const targets = worktrees.filter((wt) => wt.status !== "active");
    for (const wt of targets) {
      await cleanup(wt);
    }
  }, [worktrees, cleanup]);

  const staleCount = worktrees.filter((wt) => wt.status === "stale").length;
  const orphanCount = worktrees.filter((wt) => wt.status === "orphan").length;
  const activeCount = worktrees.filter((wt) => wt.status === "active").length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Worktree Hygiene</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {worktrees.length} worktrees &mdash;{" "}
            <span className="text-green-400">{activeCount} active</span>
            {staleCount > 0 && <>, <span className="text-yellow-400">{staleCount} stale</span></>}
            {orphanCount > 0 && <>, <span className="text-red-400">{orphanCount} orphan</span></>}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchWorktrees}
            disabled={loading}
            className="px-3 py-1.5 text-sm rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
          >
            {loading ? "Scanning..." : "Refresh"}
          </button>
          {(staleCount + orphanCount) > 0 && (
            <button
              onClick={cleanupAll}
              className="px-3 py-1.5 text-sm rounded bg-red-900/60 text-red-300 hover:bg-red-800/60 transition-colors"
            >
              Clean All ({staleCount + orphanCount})
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-900/30 text-red-400 text-sm">{error}</div>
      )}

      {loading && worktrees.length === 0 ? (
        <div className="text-zinc-500 text-center py-12">Scanning worktrees...</div>
      ) : worktrees.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-zinc-400 text-lg mb-2">No worktrees found</div>
          <div className="text-zinc-600 text-sm">All clean. Nothing to do.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {worktrees.map((wt) => {
            const badge = STATUS_BADGE[wt.status];
            const isCleaning = cleaning.has(wt.path);
            const wtLogs = logs[wt.path];

            return (
              <div
                key={wt.path}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    {/* Name + Status */}
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-white font-medium truncate">{wt.name}</span>
                      <span className={`px-2 py-0.5 rounded text-xs ${badge.bg} ${badge.text}`}>
                        {badge.label}
                      </span>
                      {wt.tmuxWindow && (
                        <span className="text-xs text-zinc-500">tmux: {wt.tmuxWindow}</span>
                      )}
                    </div>

                    {/* Details */}
                    <div className="text-xs text-zinc-500 space-y-0.5">
                      <div className="truncate">
                        <span className="text-zinc-600">repo:</span>{" "}
                        <span className="text-zinc-400">{wt.mainRepo}</span>
                      </div>
                      <div className="truncate">
                        <span className="text-zinc-600">branch:</span>{" "}
                        <span className="text-blue-400">{wt.branch}</span>
                      </div>
                      <div className="truncate">
                        <span className="text-zinc-600">path:</span>{" "}
                        <span className="text-zinc-500">{wt.path}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  {wt.status !== "active" && (
                    <button
                      onClick={() => cleanup(wt)}
                      disabled={isCleaning}
                      className="px-3 py-1.5 text-sm rounded bg-zinc-800 text-zinc-300 hover:bg-red-900/60 hover:text-red-300 disabled:opacity-50 transition-colors shrink-0"
                    >
                      {isCleaning ? "Cleaning..." : "Remove"}
                    </button>
                  )}
                </div>

                {/* Cleanup log */}
                {wtLogs && (
                  <div className="mt-2 p-2 rounded bg-zinc-950 text-xs font-mono text-zinc-400 space-y-0.5">
                    {wtLogs.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
