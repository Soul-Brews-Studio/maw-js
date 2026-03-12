import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";

export interface RecentEntry {
  name: string;
  session: string;
  target: string;
  lastBusy: number;
}

interface FleetStore {
  // Recently active: target → agent metadata + timestamp
  recentMap: Record<string, RecentEntry>;
  markBusy: (agents: { target: string; name: string; session: string }[]) => void;
  pruneRecent: () => void;

  // Slept agents (Ctrl+C'd from UI — grey + collapsed until wake/busy)
  sleptTargets: string[];
  markSlept: (target: string) => void;
  clearSlept: (target: string) => void;

  // UI preferences
  sortMode: "active" | "name";
  setSortMode: (mode: "active" | "name") => void;
  grouped: boolean;
  toggleGrouped: () => void;
  collapsed: string[];
  toggleCollapsed: (key: string) => void;
  muted: boolean;
  toggleMuted: () => void;

  // Route persistence
  lastView: string;
  setLastView: (view: string) => void;
}

const RECENT_TTL = 30 * 60 * 1000; // 30 minutes

// --- Server-side storage adapter (cross-device persistence) ---

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWrite: string | null = null;

function flushWrite() {
  if (pendingWrite === null) return;
  const body = pendingWrite;
  pendingWrite = null;
  fetch("/api/ui-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch(() => {}); // fire-and-forget
}

const serverStorage: StateStorage = {
  getItem: async (_name) => {
    try {
      const res = await fetch("/api/ui-state");
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || Object.keys(data).length === 0) return null;
      return JSON.stringify({ state: data, version: 2 });
    } catch {
      return null;
    }
  },
  setItem: async (_name, value) => {
    try {
      const { state } = JSON.parse(value);
      pendingWrite = JSON.stringify(state);
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(flushWrite, 1000);
    } catch {}
  },
  removeItem: async (_name) => {
    try {
      await fetch("/api/ui-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {}
  },
};

export const useFleetStore = create<FleetStore>()(
  persist(
    (set, get) => ({
      recentMap: {},
      markBusy: (agents) => set((s) => {
        const now = Date.now();
        const next = { ...s.recentMap };
        let changed = false;
        for (const a of agents) {
          const prev = next[a.target];
          if (!prev || prev.lastBusy !== now || prev.name !== a.name || prev.session !== a.session) {
            next[a.target] = { name: a.name, session: a.session, target: a.target, lastBusy: now };
            changed = true;
          }
        }
        return changed ? { recentMap: next } : s;
      }),
      pruneRecent: () => set((s) => {
        const now = Date.now();
        const next: Record<string, RecentEntry> = {};
        let changed = false;
        for (const [k, v] of Object.entries(s.recentMap)) {
          if (now - v.lastBusy < RECENT_TTL) next[k] = v;
          else changed = true;
        }
        return changed ? { recentMap: next } : s;
      }),

      sleptTargets: [],
      markSlept: (target) => set((s) => ({
        sleptTargets: s.sleptTargets.includes(target) ? s.sleptTargets : [...s.sleptTargets, target],
      })),
      clearSlept: (target) => set((s) => ({
        sleptTargets: s.sleptTargets.filter(t => t !== target),
      })),

      sortMode: "active",
      setSortMode: (mode) => set({ sortMode: mode }),
      grouped: true,
      toggleGrouped: () => set((s) => ({ grouped: !s.grouped })),
      collapsed: [],
      toggleCollapsed: (key) => set((s) => ({
        collapsed: s.collapsed.includes(key)
          ? s.collapsed.filter(k => k !== key)
          : [...s.collapsed, key],
      })),
      muted: false,
      toggleMuted: () => set((s) => ({ muted: !s.muted })),

      lastView: "office",
      setLastView: (view) => set({ lastView: view }),
    }),
    {
      name: "maw.fleet",
      version: 2,
      storage: serverStorage,
      partialize: (s) => ({
        recentMap: s.recentMap,
        sortMode: s.sortMode,
        grouped: s.grouped,
        collapsed: s.collapsed,
        muted: s.muted,
        sleptTargets: s.sleptTargets,
        lastView: s.lastView,
      }),
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;
        if (version < 1 && state.recentMap) {
          // v0→v1: recentMap was Record<string, number>, migrate to Record<string, RecentEntry>
          const old = state.recentMap as Record<string, unknown>;
          const next: Record<string, RecentEntry> = {};
          for (const [k, v] of Object.entries(old)) {
            if (typeof v === "number") continue;
            if (v && typeof v === "object" && "lastBusy" in v) next[k] = v as RecentEntry;
          }
          state.recentMap = next;
        }
        if (version < 2) {
          // v1→v2: recentMap keys used session:windowName, now use session:windowIndex
          // Drop stale entries — they'll repopulate with correct format
          state.recentMap = {};
        }
        return state;
      },
    }
  )
);

export const RECENT_TTL_MS = RECENT_TTL;
