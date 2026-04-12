/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import type { PluginSystem } from "../plugins";

export function pluginsView(plugins: PluginSystem) {
  const view = new Hono();

  view.get("/", (c) => {
    const s = plugins.stats();
    const up = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
    const upStr = up > 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`
      : up > 60 ? `${Math.floor(up / 60)}m ${up % 60}s` : `${up}s`;

    return c.html(
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Plugins — maw</title>
          <style>{css}</style>
        </head>
        <body>
          <h1>🔌 Plugin System v2</h1>

          <div class="stats">
            <div class="stat"><div class="n">{s.plugins.length}</div><div class="l">Plugins</div></div>
            <div class="stat"><div class="n pulse">{s.totalEvents}</div><div class="l">Events</div></div>
            <div class="stat"><div class={s.totalErrors > 0 ? "n err" : "n ok"}>{s.totalErrors}</div><div class="l">Errors</div></div>
            <div class="stat"><div class={s.gated > 0 ? "n err" : "n ok"}>{s.gated || 0}</div><div class="l">Gated</div></div>
            <div class="stat"><div class="n">{upStr}</div><div class="l">Uptime</div></div>
          </div>

          <table>
            <tr><th>Plugin</th><th>Type</th><th>Events</th><th>Errors</th><th>Last Event</th><th>Loaded</th></tr>
            {s.plugins.map(p => (
              <tr>
                <td><strong>{p.name}</strong></td>
                <td><span class={`tag ${p.type}`}>{p.type}</span></td>
                <td>{p.events}</td>
                <td class={p.errors > 0 ? "err" : "ok"}>{p.errors}</td>
                <td>{p.lastEvent || "—"}</td>
                <td>{new Date(p.loadedAt).toLocaleTimeString()}</td>
              </tr>
            ))}
          </table>

          {[
            { label: "Gates (Phase 0)", data: s.gates || {} },
            { label: "Filters (Phase 1)", data: s.filters || {} },
            { label: "Handlers (Phase 2)", data: s.handlers || {} },
            { label: "Lates (Phase 3)", data: s.lates || {} },
          ].filter(p => Object.keys(p.data).length > 0).map(phase => (
            <div class="hook">
              <h3>{phase.label}</h3>
              <div class="hook-list">
                {Object.entries(phase.data).map(([k, v]) => (
                  <div class="hook-item">{k}<span class="count">&times;{v as number}</span></div>
                ))}
              </div>
            </div>
          ))}

          <script>{`setInterval(()=>location.reload(),5000)`}</script>
        </body>
      </html>
    );
  });

  return view;
}

const css = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#020a18;color:#e0e0e0;font:13px/1.6 monospace;padding:24px}
h1{color:#00f5d4;font-size:18px;margin-bottom:16px}
.stats{display:flex;gap:24px;margin-bottom:24px}
.stat{background:#0a1628;border:1px solid #1a2a40;border-radius:8px;padding:12px 20px}
.stat .n{font-size:28px;font-weight:bold;color:#00f5d4}
.stat .l{font-size:10px;color:#607080;text-transform:uppercase;letter-spacing:1px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
th{text-align:left;font-size:10px;color:#607080;text-transform:uppercase;letter-spacing:1px;padding:8px 12px;border-bottom:1px solid #1a2a40}
td{padding:8px 12px;border-bottom:1px solid #0d1a2a}
tr:hover{background:#0a1628}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:bold}
.ts{background:#00f5d420;color:#00f5d4}
.wasm-shared{background:#9b5de520;color:#9b5de5}
.wasm-wasi{background:#f15bb520;color:#f15bb5}
.js{background:#fee44020;color:#fee440}
.hook{background:#0a1628;border:1px solid #1a2a40;border-radius:8px;padding:16px;margin-bottom:16px}
.hook h3{font-size:12px;color:#607080;margin-bottom:8px}
.hook-list{display:flex;flex-wrap:wrap;gap:6px}
.hook-item{background:#061525;padding:4px 10px;border-radius:4px;font-size:11px}
.hook-item .count{color:#00f5d4;margin-left:4px}
.err{color:#f15bb5}.ok{color:#00f5d4}
.pulse{animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
`;
