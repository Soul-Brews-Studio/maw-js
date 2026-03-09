import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Session, AgentState, AgentEvent } from "../lib/types";
import { playSaiyanSound } from "../lib/sounds";
import { agentSortKey } from "../lib/constants";

// WASM VM types (from office-vm pkg)
let OfficeVM: any = null;
let vmInstance: any = null;
let wasmReady = false;

async function ensureWasm() {
  if (wasmReady) return vmInstance;
  try {
    const wasm = await import("../wasm-vm/office_vm.js");
    await wasm.default();
    OfficeVM = wasm.OfficeVM;
    vmInstance = new OfficeVM();
    wasmReady = true;
    console.log("[office-vm] WASM engine loaded");
    return vmInstance;
  } catch (e) {
    console.warn("[office-vm] WASM load failed, falling back", e);
    return null;
  }
}

/**
 * Drop-in replacement for useSessions() — same return type.
 * Data pipeline: WebSocket → WASM VM → React state
 *
 * The WASM VM owns:
 *   - Agent state (status detection, preview extraction)
 *   - Room grouping
 *   - Activity feed
 *   - Saiyan detection
 *
 * JS/React owns:
 *   - Network (WebSocket, REST polling)
 *   - Rendering (SVG, CSS, animations)
 *   - Sound effects
 */
export function useSessionsWasm() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [saiyanTargets, setSaiyanTargets] = useState<Set<string>>(new Set());
  const [eventLog, setEventLog] = useState<AgentEvent[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const pollTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastSoundTime = useRef(0);
  const saiyanTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const vmRef = useRef<any>(null);

  // Initialize WASM
  useEffect(() => {
    ensureWasm().then((vm) => {
      vmRef.current = vm;
    });
  }, []);

  const addEvent = useCallback((target: string, type: AgentEvent["type"], detail: string) => {
    setEventLog((prev) => {
      const next = [...prev, { time: Date.now(), target, type, detail }];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  const handleMessage = useCallback((data: any) => {
    if (data.type === "sessions") {
      setSessions(data.sessions);
      // Push session tree into WASM VM
      const vm = vmRef.current;
      if (vm) {
        try {
          vm.update_sessions(data.sessions);
        } catch (e) {
          console.warn("[office-vm] update_sessions error", e);
        }
      }
    }
  }, []);

  // Poll captures → push into WASM → read state back
  useEffect(() => {
    async function poll() {
      const vm = vmRef.current;
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
              const content = data.content || "";

              if (vm) {
                // Let WASM do the heavy lifting
                vm.push_capture(target, content);
              }
            } catch {}
          })
        );
      }

      // Read state back from WASM
      if (vm) {
        try {
          const wasmAgents = vm.get_agents() as any[];
          const wasmFeed = vm.get_feed(200) as any[];
          const wasmSaiyan = vm.get_saiyan_targets() as string[];

          // Convert to AgentState[] and sort
          const agentList: AgentState[] = wasmAgents.map((a: any) => ({
            target: a.target,
            name: a.name,
            session: a.session,
            windowIndex: a.window_index,
            active: a.active,
            preview: a.preview,
            status: a.status,
          }));
          agentList.sort((a, b) => agentSortKey(a.name) - agentSortKey(b.name));
          setAgents(agentList);

          // Sync feed
          if (wasmFeed.length > 0) {
            setEventLog(wasmFeed.map((e: any) => ({
              time: e.time,
              target: e.target,
              type: e.event_type as AgentEvent["type"],
              detail: e.detail,
            })));
          }

          // Saiyan sound + animation
          const newSaiyan = new Set(wasmSaiyan);
          setSaiyanTargets((prev) => {
            for (const t of newSaiyan) {
              if (!prev.has(t)) {
                // New saiyan — play sound (max once per 60s)
                const now = Date.now();
                if (now - lastSoundTime.current > 60000) {
                  lastSoundTime.current = now;
                  playSaiyanSound();
                }
                // Auto-dismiss after 10s
                clearTimeout(saiyanTimers.current[t]);
                saiyanTimers.current[t] = setTimeout(() => {
                  if (vm) vm.dismiss_saiyan(t);
                  setSaiyanTargets((p) => {
                    const next = new Set(p);
                    next.delete(t);
                    return next;
                  });
                }, 10000);
              }
            }
            return newSaiyan;
          });
        } catch (e) {
          console.warn("[office-vm] read state error", e);
        }
      }

      pollTimer.current = setTimeout(poll, 5000);
    }
    poll();
    return () => clearTimeout(pollTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { sessions, agents, saiyanTargets, eventLog, addEvent, handleMessage };
}
