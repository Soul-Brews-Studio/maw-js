import type { ServeHttpRouteRegistrar } from "maw-js/plugin/types";

type PluginStats = {
  startedAt?: string;
  plugins?: Array<{
    name: string;
    type: string;
    events: number;
    errors: number;
    loadedAt: string;
    lastEvent?: string;
  }>;
  totalEvents?: number;
  totalErrors?: number;
  gated?: number;
  gates?: Record<string, number>;
  filters?: Record<string, number>;
  handlers?: Record<string, number>;
  lates?: Record<string, number>;
};

type ServeDebugContext = {
  http?: ServeHttpRouteRegistrar;
  plugins?: { stats?: () => PluginStats };
  reloadPlugins?: () => unknown | Promise<unknown>;
};

function pluginStats(ctx: ServeDebugContext): PluginStats {
  return ctx.plugins?.stats?.() ?? {
    startedAt: new Date().toISOString(),
    plugins: [],
    totalEvents: 0,
    totalErrors: 0,
    gated: 0,
    gates: {},
    filters: {},
    handlers: {},
    lates: {},
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function uptimeLabel(startedAt: unknown): string {
  const start = typeof startedAt === "string" ? new Date(startedAt).getTime() : Date.now();
  const up = Math.max(0, Math.round((Date.now() - start) / 1000));
  if (up > 3600) return `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
  if (up > 60) return `${Math.floor(up / 60)}m ${up % 60}s`;
  return `${up}s`;
}

function renderHookSection(label: string, data: Record<string, number> = {}): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  return `<div class="hook"><h3>${escapeHtml(label)}</h3><div class="hook-list">${entries
    .map(([k, v]) => `<div class="hook-item">${escapeHtml(k)}<span class="count">&times;${escapeHtml(v)}</span></div>`)
    .join("")}</div></div>`;
}

export function renderPluginsPage(stats: PluginStats): string {
  const plugins = stats.plugins ?? [];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plugins — maw</title><style>${css}</style></head><body>
<h1>🔌 Plugin System v2</h1>
<div class="stats">
  <div class="stat"><div class="n">${escapeHtml(plugins.length)}</div><div class="l">Plugins</div></div>
  <div class="stat"><div class="n pulse">${escapeHtml(stats.totalEvents ?? 0)}</div><div class="l">Events</div></div>
  <div class="stat"><div class="${(stats.totalErrors ?? 0) > 0 ? "n err" : "n ok"}">${escapeHtml(stats.totalErrors ?? 0)}</div><div class="l">Errors</div></div>
  <div class="stat"><div class="${(stats.gated ?? 0) > 0 ? "n err" : "n ok"}">${escapeHtml(stats.gated ?? 0)}</div><div class="l">Gated</div></div>
  <div class="stat"><div class="n">${escapeHtml(uptimeLabel(stats.startedAt))}</div><div class="l">Uptime</div></div>
</div>
<table><tr><th>Plugin</th><th>Type</th><th>Events</th><th>Errors</th><th>Last Event</th><th>Loaded</th></tr>${plugins.map((p) => `<tr>
  <td><strong>${escapeHtml(p.name)}</strong></td>
  <td><span class="tag ${escapeHtml(p.type)}">${escapeHtml(p.type)}</span></td>
  <td>${escapeHtml(p.events)}</td>
  <td class="${p.errors > 0 ? "err" : "ok"}">${escapeHtml(p.errors)}</td>
  <td>${escapeHtml(p.lastEvent || "—")}</td>
  <td>${escapeHtml(new Date(p.loadedAt).toLocaleTimeString())}</td>
</tr>`).join("")}</table>
${renderHookSection("Gates (Phase 0)", stats.gates)}
${renderHookSection("Filters (Phase 1)", stats.filters)}
${renderHookSection("Handlers (Phase 2)", stats.handlers)}
${renderHookSection("Lates (Phase 3)", stats.lates)}
<script>setInterval(()=>location.reload(),5000)</script>
</body></html>`;
}

export function serve(ctx: ServeDebugContext) {
  if (!ctx.http) throw new Error("serve-debug requires serve http route registration");

  ctx.http.route("GET", "/api/plugins", () => Response.json(pluginStats(ctx)));
  ctx.http.route("POST", "/api/plugins/reload", async () => {
    if (ctx.reloadPlugins) return Response.json(await ctx.reloadPlugins());
    return Response.json({ ok: false, error: "plugin reload unavailable", ...pluginStats(ctx) }, { status: 503 });
  });
  ctx.http.route("GET", "/plugins", () => new Response(renderPluginsPage(pluginStats(ctx)), {
    headers: { "content-type": "text/html; charset=utf-8" },
  }));

  return { ok: true };
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

export default serve;
