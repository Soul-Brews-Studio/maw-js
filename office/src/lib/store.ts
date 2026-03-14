import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";

export interface RecentEntry {
  name: string;
  session: string;
  target: string;
  lastBusy: number;
}

import type { AskItem } from "./types";

interface FleetStore {
  // Recently active: target → agent metadata + timestamp
  recentMap: Record<string, RecentEntry>;
  markBusy: (agents: { target: string; name: string; session: string }[], at?: number) => void;
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
  stageMode: "stage" | "pitch";
  toggleStageMode: () => void;

  // Route persistence
  lastView: string;
  setLastView: (view: string) => void;

  // Inbox asks
  asks: AskItem[];
  addAsk: (ask: Omit<AskItem, "id" | "ts">) => void;
  dismissAsk: (id: string) => void;
  dismissByOracle: (oracle: string) => void;
}

const RECENT_TTL = 30 * 60 * 1000; // 30 minutes

// --- Hybrid storage: localStorage for instant hydration + server for cross-device sync ---

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

/** Sync server state into localStorage, then rehydrate Zustand. */
function syncFromServer(name: string) {
  fetch("/api/ui-state").then(async (res) => {
    if (!res.ok) return;
    const data = await res.json();
    if (!data || Object.keys(data).length === 0) return;
    const value = JSON.stringify({ state: data, version: 2 });
    const existing = localStorage.getItem(name);
    if (value !== existing) {
      localStorage.setItem(name, value);
      useFleetStore.persist.rehydrate();
    }
  }).catch(() => {});
}

const hybridStorage: StateStorage = {
  getItem: (name) => {
    // Return localStorage synchronously → instant hydration
    // Then background-sync from server for cross-device updates
    setTimeout(() => syncFromServer(name), 0);
    return localStorage.getItem(name);
  },
  setItem: (name, value) => {
    // Write to localStorage immediately (instant on next refresh)
    localStorage.setItem(name, value);
    // Debounced write to server (cross-device sync)
    try {
      const { state } = JSON.parse(value);
      pendingWrite = JSON.stringify(state);
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(flushWrite, 1000);
    } catch {}
  },
  removeItem: (name) => {
    localStorage.removeItem(name);
    fetch("/api/ui-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  },
};

// --- Asks persistence (separate from ui-state) ---
let askSaveTimer: ReturnType<typeof setTimeout> | null = null;
function persistAsks(asks: AskItem[]) {
  if (askSaveTimer) clearTimeout(askSaveTimer);
  askSaveTimer = setTimeout(() => {
    fetch("/api/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(asks),
    }).catch(() => {});
  }, 1000);
}

export const useFleetStore = create<FleetStore>()(
  persist(
    (set, get) => ({
      recentMap: {},
      markBusy: (agents, at) => set((s) => {
        const ts = at ?? Date.now();
        const next = { ...s.recentMap };
        let changed = false;
        for (const a of agents) {
          const prev = next[a.target];
          // Only update if new timestamp is more recent
          if (!prev || prev.lastBusy < ts || prev.name !== a.name || prev.session !== a.session) {
            next[a.target] = { name: a.name, session: a.session, target: a.target, lastBusy: ts };
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
      stageMode: "pitch",
      toggleStageMode: () => set((s) => ({ stageMode: s.stageMode === "pitch" ? "stage" : "pitch" })),

      lastView: "office",
      setLastView: (view) => set({ lastView: view }),

      // Inbox asks
      asks: [],
      addAsk: (ask) => set((s) => {
        const existing = s.asks.find((a) => a.oracle === ask.oracle && !a.dismissed);
        if (existing) {
          // Update message if new one is longer (Stop event has the real question)
          if (ask.message.length > existing.message.length) {
            const next = s.asks.map((a) => a.id === existing.id ? { ...a, message: ask.message, type: ask.type } : a);
            persistAsks(next);
            return { asks: next };
          }
          return s;
        }
        const item: AskItem = { ...ask, id: `${ask.oracle}-${Date.now()}`, ts: Date.now() };
        const next = [item, ...s.asks].slice(0, 50);
        persistAsks(next);
        return { asks: next };
      }),
      dismissAsk: (id) => set((s) => {
        const next = s.asks.map((a) => (a.id === id ? { ...a, dismissed: true } : a));
        persistAsks(next);
        return { asks: next };
      }),
      dismissByOracle: (oracle) => set((s) => {
        const hasPending = s.asks.some((a) => a.oracle === oracle && !a.dismissed);
        if (!hasPending) return s;
        const next = s.asks.map((a) => (a.oracle === oracle && !a.dismissed ? { ...a, dismissed: true } : a));
        persistAsks(next);
        return { asks: next };
      }),
    }),
    {
      name: "maw.fleet",
      version: 2,
      storage: hybridStorage,
      partialize: (s) => ({
        recentMap: s.recentMap,
        sortMode: s.sortMode,
        grouped: s.grouped,
        collapsed: s.collapsed,
        muted: s.muted,
        stageMode: s.stageMode,
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

// Load asks from server on startup
setTimeout(() => {
  fetch("/api/asks")
    .then((r) => r.json())
    .then((data: AskItem[]) => {
      if (Array.isArray(data) && data.length > 0) {
        useFleetStore.setState({ asks: data });
      }
    })
    .catch(() => {});
}, 0);

export const RECENT_TTL_MS = RECENT_TTL;
