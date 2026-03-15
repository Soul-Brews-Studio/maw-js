import { useState, useRef, useCallback, useEffect, memo } from "react";
import { apiUrl } from "../lib/api";

interface SearchResult {
  id: number;
  title: string;
  content: string;
  type: string;
  source: string;
  score?: number;
  distance?: number;
  project?: string;
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
  mode?: string;
  model?: string;
  warning?: string;
}

interface Trace {
  traceId: string;
  query: string;
  scope: string;
  fileCount: number;
  commitCount: number;
  status: string;
  createdAt: number;
}

interface OracleSearchProps {
  onClose: () => void;
}

export const OracleSearch = memo(function OracleSearch({ onClose }: OracleSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ total: number; mode?: string; model?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"hybrid" | "fts" | "vector">("hybrid");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load recent traces on mount
  useEffect(() => {
    inputRef.current?.focus();
    fetch(apiUrl("/api/oracle/traces?limit=8"))
      .then((r) => r.json())
      .then((data) => setTraces(data.traces || []))
      .catch(() => {});
  }, []);

  const search = useCallback(async (q: string, m: string) => {
    if (!q.trim()) { setResults([]); setMeta(null); setError(null); return; }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: q.trim(), mode: m, limit: "20" });
      const res = await fetch(apiUrl(`/api/oracle/search?${params}`), { signal: ac.signal });
      const data: SearchResponse = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data.results || []);
      setMeta({ total: data.total, mode: data.mode, model: data.model });
    } catch (e: any) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "Enter") { e.preventDefault(); search(query, mode); }
  }, [query, mode, search, onClose]);

  // Type badge colors
  const typeBadge = (type: string) => {
    const colors: Record<string, string> = {
      learning: "#ffa726",
      trace: "#42a5f5",
      thread: "#7e57c2",
      resonance: "#ef5350",
      retro: "#4caf50",
      handoff: "#26c6da",
      concept: "#fdd835",
    };
    return colors[type] || "#888";
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center pt-[10vh]"
      style={{ background: "rgba(2,2,8,0.85)", backdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col w-full max-w-[640px] rounded-xl border border-white/[0.08] shadow-2xl overflow-hidden"
        style={{ background: "#0a0a0f", maxHeight: "75vh" }}
      >
        {/* Search header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#64b5f6" strokeWidth={2} strokeLinecap="round">
            <circle cx={11} cy={11} r={8} />
            <line x1={21} y1={21} x2={16.65} y2={16.65} />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-white/90 outline-none caret-[#64b5f6] font-mono text-sm [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
            style={{ WebkitAppearance: "none" }}
            placeholder="Search Oracle knowledge..."
            inputMode="text"
            enterKeyHint="search"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          {/* Mode toggle */}
          <div className="flex items-center gap-1">
            {(["hybrid", "fts", "vector"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); if (query.trim()) search(query, m); }}
                className="px-2 py-0.5 rounded text-[9px] font-mono cursor-pointer transition-colors"
                style={{
                  background: mode === m ? "#64b5f620" : "transparent",
                  color: mode === m ? "#64b5f6" : "#ffffff40",
                  border: `1px solid ${mode === m ? "#64b5f640" : "transparent"}`,
                }}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            onClick={() => search(query, mode)}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-[#64b5f6] text-black text-xs font-bold cursor-pointer hover:bg-[#90caf9] active:bg-[#42a5f5] transition-colors disabled:opacity-50"
          >
            {loading ? "..." : "Search"}
          </button>
        </div>

        {/* Meta bar */}
        {meta && (
          <div className="flex items-center gap-3 px-4 py-1.5 bg-white/[0.02] border-b border-white/[0.04] text-[10px] font-mono text-white/40">
            <span>{meta.total} results</span>
            {meta.mode && <span>mode: {meta.mode}</span>}
            {meta.model && <span>model: {meta.model}</span>}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400 font-mono">
            {error}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {/* Recent traces — shown when no search yet */}
          {results.length === 0 && !meta && traces.length > 0 && (
            <div>
              <div className="px-4 py-2 text-[10px] font-mono text-white/30 uppercase tracking-[2px] border-b border-white/[0.04]">
                Recent Traces
              </div>
              {traces.map((t) => {
                const age = Date.now() - t.createdAt;
                const mins = Math.floor(age / 60000);
                const timeAgo = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
                return (
                  <div
                    key={t.traceId}
                    className="px-4 py-2.5 border-b border-white/[0.04] hover:bg-white/[0.02] cursor-pointer transition-colors"
                    onClick={() => { setQuery(t.query); search(t.query, mode); }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[#42a5f5]/60 font-mono">&#x25C9;</span>
                      <span className="text-xs text-white/80 flex-1 truncate">{t.query}</span>
                      <span className="text-[9px] font-mono text-white/20">{timeAgo}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 ml-5 text-[9px] font-mono text-white/25">
                      <span>{t.scope}</span>
                      <span>{t.fileCount} files</span>
                      <span className="px-1 py-0 rounded text-[8px]" style={{ background: t.status === "raw" ? "#ffa72610" : "#4caf5010", color: t.status === "raw" ? "#ffa726" : "#4caf50" }}>{t.status}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {results.length === 0 && !loading && query && meta && (
            <div className="px-4 py-8 text-center text-white/30 text-sm font-mono">
              No results for "{query}"
            </div>
          )}
          {results.map((r) => {
            const expanded = expandedId === r.id;
            const snippet = r.content?.slice(0, 200) || "";
            const fullContent = r.content || "";
            return (
              <div
                key={r.id}
                className="px-4 py-3 border-b border-white/[0.04] hover:bg-white/[0.02] cursor-pointer transition-colors"
                onClick={() => setExpandedId(expanded ? null : r.id)}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="px-1.5 py-0.5 rounded text-[8px] font-mono font-bold uppercase"
                    style={{ background: `${typeBadge(r.type)}20`, color: typeBadge(r.type) }}
                  >
                    {r.type}
                  </span>
                  <span className={`text-sm font-medium truncate flex-1 ${r.title ? "text-white/90" : "text-white/40 italic"}`}>
                    {r.title || r.content?.slice(0, 60)?.trim() || `${r.type} #${r.id}`}
                  </span>
                  {r.score != null && (
                    <span className="text-[9px] font-mono text-white/30">
                      fts:{r.score.toFixed(1)}
                    </span>
                  )}
                  {r.distance != null && (
                    <span className="text-[9px] font-mono text-[#64b5f6]/60">
                      vec:{r.distance.toFixed(3)}
                    </span>
                  )}
                </div>
                <div
                  className="text-[11px] font-mono leading-relaxed text-white/50 whitespace-pre-wrap break-words"
                  style={{ maxHeight: expanded ? "none" : 48, overflow: "hidden" }}
                >
                  {expanded ? fullContent : snippet}
                  {!expanded && fullContent.length > 200 && "..."}
                </div>
                {r.source && (
                  <div className="mt-1 text-[9px] font-mono text-white/20 truncate">
                    {r.source}
                    {r.project && <span className="ml-2 text-[#64b5f6]/40">[{r.project}]</span>}
                  </div>
                )}
              </div>
            );
          })}
          {loading && (
            <div className="px-4 py-6 text-center">
              <span className="inline-block w-4 h-4 border-2 border-[#64b5f6]/30 border-t-[#64b5f6] rounded-full" style={{ animation: "spin 0.8s linear infinite" }} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-1.5 bg-[#08080c] border-t border-white/[0.04] text-[8px] font-mono text-white/20">
          <span><kbd className="text-white/30">Enter</kbd> search · <kbd className="text-white/30">Esc</kbd> close</span>
          <span>maw v1.1.0 · oracle-v2 · bge-m3</span>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
});
