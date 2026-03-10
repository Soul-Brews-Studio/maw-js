import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Session, AgentState, PaneStatus, AgentEvent } from "../lib/types";
import { stripAnsi } from "../lib/ansi";
import { playSaiyanSound } from "../lib/sounds";
import { agentSortKey } from "../lib/constants";

// Simple string hash
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [captureData, setCaptureData] = useState<Record<string, { preview: string; status: PaneStatus }>>({});
  const pollTimer = useRef<ReturnType<typeof setTimeout>>();
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Track content hashes for change detection
  const hashHistory = useRef<Record<string, { prev: number; curr: number; unchangedCount: number }>>({});
  const lastSoundTime = useRef(0);
  const [saiyanTargets, setSaiyanTargets] = useState<Set<string>>(new Set());
  const saiyanTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [eventLog, setEventLog] = useState<AgentEvent[]>([]);
  const MAX_EVENTS = 200;

  const addEvent = useCallback((target: string, type: AgentEvent["type"], detail: string) => {
    setEventLog(prev => {
      const next = [...prev, { time: Date.now(), target, type, detail }];
      return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
    });
  }, []);

  const handleMessage = useCallback((data: any) => {
    if (data.type === "sessions") {
      setSessions(data.sessions);
    } else if (data.type === "previews") {
      // Lightweight preview updates from viewport-aware subscription
      const previews: Record<string, string> = data.data;
      setCaptureData((prev) => {
        let next = prev;
        for (const [target, raw] of Object.entries(previews)) {
          const text = stripAnsi(raw);
          const lines = text.split("\n").filter((l: string) => l.trim());
          const preview = (lines[lines.length - 1] || "").slice(0, 120);
          const existing = next[target];
          if (!existing || existing.preview !== preview) {
            if (next === prev) next = { ...prev };
            next[target] = { preview, status: existing?.status || "idle" };
          }
        }
        return next;
      });
    }
  }, []);

  // Poll captures — detect busy by content change
  useEffect(() => {
    async function poll() {
      const targets: string[] = [];
      sessionsRef.current.forEach((s) =>
        s.windows.forEach((w) => targets.push(`${s.name}:${w.index}`))
      );
      for (let i = 0; i < targets.length; i += 4) {
        const batch = targets.slice(i, i + 4);
        await Promise.allSettled(
          batch.map(async (target) => {
            try {
              const res = await fetch(`/api/capture?target=${encodeURIComponent(target)}`);
              const data = await res.json();
              const raw = data.content || "";
              const text = stripAnsi(raw);

              // Exclude bottom 15% (status bar, prompt, timers, token counters)
              const allLines = text.split("\n");
              const cutoff = Math.max(1, Math.floor(allLines.length * 0.85));
              const topPart = allLines.slice(0, cutoff).join("\n");
              const contentHash = hash(topPart);

              // Track hash changes
              const entry = hashHistory.current[target] || { prev: 0, curr: 0, unchangedCount: 0 };
              entry.prev = entry.curr;
              entry.curr = contentHash;

              if (entry.prev !== 0 && entry.prev !== entry.curr) {
                // Content changed → busy
                entry.unchangedCount = 0;
              } else {
                // Content same → increment stable count
                entry.unchangedCount++;
              }
              hashHistory.current[target] = entry;

              // Check bottom lines for known indicators
              const lines = text.split("\n").filter((l: string) => l.trim());
              const bottom = lines.slice(-5).join("\n");
              const hasPrompt = bottom.includes("\u276f"); // ❯
              const hasBusySign = /[∴✢⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]/.test(bottom) || /● \w+\(/.test(bottom) || /\b(Read|Edit|Write|Bash|Grep|Glob|Agent)\b/.test(bottom); // Thinking/tool calls/Claude Code tools

              // Determine status (slower transitions to avoid flicker)
              let status: PaneStatus;
              if (hasBusySign) {
                // Explicit busy indicator always wins
                status = "busy";
              } else if (hasPrompt && entry.unchangedCount >= 2) {
                // Prompt visible + content stable for 2+ polls → ready
                status = "ready";
              } else if (entry.prev === 0) {
                // First poll
                status = hasPrompt ? "ready" : "idle";
              } else if (entry.unchangedCount <= 3) {
                // Changed recently (within ~15s) → busy
                status = "busy";
              } else if (entry.unchangedCount <= 8) {
                // Cooling down → ready
                status = "ready";
              } else {
                // Stable for long → check prompt for ready vs idle
                status = hasPrompt ? "ready" : "idle";
              }

              const preview = (lines[lines.length - 1] || "").slice(0, 120);

              setCaptureData((p) => {
                const existing = p[target];
                if (existing && existing.preview === preview && existing.status === status) return p;
                // Log status change
                if (existing && existing.status !== status) {
                  addEvent(target, "status", `${existing.status} → ${status}`);
                }
                // Play power-up sound on transition to busy (max once per 60s)
                if (status === "busy" && existing?.status !== "busy") {
                  const now = Date.now();
                  if (now - lastSoundTime.current > 60000) {
                    lastSoundTime.current = now;
                    playSaiyanSound();
                  }
                  // 10s saiyan burst animation
                  clearTimeout(saiyanTimers.current[target]);
                  setSaiyanTargets(prev => new Set(prev).add(target));
                  saiyanTimers.current[target] = setTimeout(() => {
                    setSaiyanTargets(prev => {
                      const next = new Set(prev);
                      next.delete(target);
                      return next;
                    });
                  }, 10000);
                }
                return { ...p, [target]: { preview, status } };
              });
            } catch {}
          })
        );
      }
      pollTimer.current = setTimeout(poll, 5000);
    }
    poll();
    return () => clearTimeout(pollTimer.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive flat agent list (memoized to prevent re-renders)
  const agents: AgentState[] = useMemo(() => {
    const list = sessions.flatMap((s) =>
      s.windows.map((w) => {
        const key = `${s.name}:${w.index}`;
        const cd = captureData[key];
        return {
          target: key,
          name: w.name,
          session: s.name,
          windowIndex: w.index,
          active: w.active,
          preview: cd?.preview || "",
          status: cd?.status || "idle",
        };
      })
    );
    list.sort((a, b) => agentSortKey(a.name) - agentSortKey(b.name));
    return list;
  }, [sessions, captureData]);

  return { sessions, agents, saiyanTargets, eventLog, addEvent, handleMessage };
}
