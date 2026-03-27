import { useState, useEffect, useMemo, useRef } from "react";
import { type MawLogEntry, formatDate, pairKey } from "./types";
import { apiUrl, wsUrl } from "../../lib/api";

export function useChatLog(mode: string) {
  const [entries, setEntries] = useState<MawLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    fetch(apiUrl("/api/maw-log?limit=500"))
      .then((r) => r.json())
      .then((data) => {
        setEntries((data.entries || []).filter((e: MawLogEntry) => e.from && e.to));
        setTotal(data.total || 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Real-time: listen for WebSocket push of new maw-log entries
  useEffect(() => {
    const url = wsUrl("/ws");
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(url);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "maw-log" && msg.entries) {
            setEntries(prev => [...prev, ...msg.entries]);
            setTotal(prev => prev + msg.entries.length);
            if (mode === "live") {
              requestAnimationFrame(() => {
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              });
            }
          }
        } catch {}
      };
    } catch {}
    return () => { ws?.close(); };
  }, [mode]);

  return { entries, total, loading, scrollRef };
}

export function useOracleNames(entries: MawLogEntry[]) {
  return useMemo(() => {
    const names = new Set<string>();
    for (const e of entries) {
      names.add(e.from);
      names.add(e.to);
    }
    names.delete("unknown");
    return [...names].sort();
  }, [entries]);
}

export function useFilteredEntries(entries: MawLogEntry[], filter: string) {
  return useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.from === filter || e.to === filter);
  }, [entries, filter]);
}

/** Timeline: newest first, grouped by consecutive sender, with date separators */
export function useTimelineGroups(filtered: MawLogEntry[]) {
  return useMemo(() => {
    const reversed = [...filtered].reverse();
    const result: { date: string | null; entries: MawLogEntry[] }[] = [];
    let lastDate = "";
    let lastFrom = "";
    for (const entry of reversed) {
      const date = formatDate(entry.ts);
      const isNewDate = date !== lastDate;
      const isNewSender = entry.from !== lastFrom || isNewDate;
      if (isNewSender) {
        result.push({ date: isNewDate ? date : null, entries: [entry] });
      } else {
        result[result.length - 1].entries.push(entry);
      }
      lastDate = date;
      lastFrom = entry.from;
    }
    return result;
  }, [filtered]);
}

/** Live: newest at bottom, grouped by consecutive sender */
export function useLiveGroups(filtered: MawLogEntry[]) {
  return useMemo(() => {
    const result: { entries: MawLogEntry[] }[] = [];
    let lastFrom = "";
    for (const entry of filtered) {
      if (entry.from !== lastFrom) {
        result.push({ entries: [entry] });
      } else {
        result[result.length - 1].entries.push(entry);
      }
      lastFrom = entry.from;
    }
    return result;
  }, [filtered]);
}

/** Estimate tokens from text — Thai ~1.5 chars/token, English ~4, mixed ~2.5 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count Thai chars vs ASCII
  let thai = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x0e00) thai++;
  }
  const ratio = text.length > 0 ? thai / text.length : 0;
  // Thai-heavy → ~1.5 chars/token, English-heavy → ~4 chars/token
  const charsPerToken = 1.5 + (1 - ratio) * 2.5;
  return Math.round(text.length / charsPerToken);
}

export interface TokenStats {
  totalTokens: number;
  tokensPerMin: number;
  byOracle: { name: string; tokens: number }[];
  spanMinutes: number;
}

/** Calculate token stats from entries */
export function useTokenStats(entries: MawLogEntry[]): TokenStats {
  return useMemo(() => {
    if (entries.length === 0) return { totalTokens: 0, tokensPerMin: 0, byOracle: [], spanMinutes: 0 };

    const byOracle = new Map<string, number>();
    let totalTokens = 0;

    for (const e of entries) {
      const t = estimateTokens(e.msg);
      totalTokens += t;
      byOracle.set(e.from, (byOracle.get(e.from) || 0) + t);
    }

    const times = entries.map(e => new Date(e.ts).getTime()).filter(t => !isNaN(t));
    const spanMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0;
    const spanMinutes = Math.max(spanMs / 60000, 1);
    const tokensPerMin = totalTokens / spanMinutes;

    const sorted = [...byOracle.entries()]
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => b.tokens - a.tokens);

    return { totalTokens, tokensPerMin, byOracle: sorted, spanMinutes };
  }, [entries]);
}

/** Threads: grouped by pair, newest thread first */
export function useThreads(filtered: MawLogEntry[]) {
  return useMemo(() => {
    const map = new Map<string, MawLogEntry[]>();
    for (const e of filtered) {
      const key = pairKey(e.from, e.to);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()].sort((a, b) => {
      return b[1][b[1].length - 1].ts.localeCompare(a[1][a[1].length - 1].ts);
    });
  }, [filtered]);
}
