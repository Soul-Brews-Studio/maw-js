/** Reusable editable key-value table with add/remove support */

interface KVTableProps {
  label: string;
  entries: [string, string][];
  onChange: (idx: number, field: "key" | "value", val: string) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
  masked?: boolean;
}

export function KVTable({ label, entries, onChange, onAdd, onRemove, masked }: KVTableProps) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold tracking-[2px] uppercase" style={{ color: "#7c3aed" }}>{label}</h3>
        <button
          onClick={onAdd}
          className="px-2.5 py-1 rounded-lg text-xs font-mono active:scale-95 transition-all"
          style={{ background: "rgba(34,211,238,0.1)", color: "#22d3ee", border: "1px solid rgba(34,211,238,0.2)" }}
        >
          + Add
        </button>
      </div>
      <div className="rounded-xl border border-white/[0.06] overflow-hidden" style={{ background: "#0a0a12" }}>
        {entries.length === 0 && (
          <div className="px-4 py-3 text-white/20 text-xs font-mono text-center">No entries</div>
        )}
        {entries.map(([key, value], i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.04] last:border-b-0 group"
          >
            <input
              type="text"
              value={key}
              onChange={(e) => onChange(i, "key", e.target.value)}
              className="w-[140px] sm:w-[180px] flex-shrink-0 bg-transparent text-cyan-300 outline-none font-mono text-sm px-2 py-1 rounded-md border border-transparent focus:border-cyan-400/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
              style={{ WebkitAppearance: "none" as const }}
              placeholder="key"
              spellCheck={false}
            />
            <span className="text-white/15 flex-shrink-0">|</span>
            <input
              type={masked ? "password" : "text"}
              value={value}
              onChange={(e) => onChange(i, "value", e.target.value)}
              className="flex-1 min-w-0 bg-transparent text-white/70 outline-none font-mono text-sm px-2 py-1 rounded-md border border-transparent focus:border-cyan-400/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
              style={{ WebkitAppearance: "none" as const }}
              placeholder={masked ? "value (hidden)" : "value"}
              spellCheck={false}
            />
            <button
              onClick={() => onRemove(i)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-red-400/60 hover:text-red-400 text-xs px-1.5 py-0.5 rounded flex-shrink-0"
              title="Remove"
            >
              x
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
