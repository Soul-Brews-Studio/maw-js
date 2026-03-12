/** Flat key-value fields for server configuration (host, port, etc.) */

interface ServerFieldsProps {
  host: string;
  port: number;
  ghqRoot: string;
  oracleUrl: string;
  onChange: (field: string, val: string) => void;
}

export function ServerFields({ host, port, ghqRoot, oracleUrl, onChange }: ServerFieldsProps) {
  const fields = [
    { key: "host", value: host },
    { key: "port", value: String(port) },
    { key: "ghqRoot", value: ghqRoot },
    { key: "oracleUrl", value: oracleUrl },
  ];

  return (
    <section>
      <h3 className="text-sm font-bold tracking-[2px] uppercase mb-2" style={{ color: "#7c3aed" }}>Server</h3>
      <div className="rounded-xl border border-white/[0.06] overflow-hidden" style={{ background: "#0a0a12" }}>
        {fields.map(({ key, value }) => (
          <div
            key={key}
            className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.04] last:border-b-0"
          >
            <span className="w-[140px] sm:w-[180px] flex-shrink-0 text-cyan-300 font-mono text-sm px-2">{key}</span>
            <span className="text-white/15 flex-shrink-0">|</span>
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(key, e.target.value)}
              className="flex-1 min-w-0 bg-transparent text-white/70 outline-none font-mono text-sm px-2 py-1 rounded-md border border-transparent focus:border-cyan-400/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
              style={{ WebkitAppearance: "none" as const }}
              spellCheck={false}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
