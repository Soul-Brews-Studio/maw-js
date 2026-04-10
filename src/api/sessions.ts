import { Hono } from "hono";
import { listSessions, capture, sendKeys, selectWindow, findWindow } from "../ssh";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../peers";
import { loadConfig } from "../config";
import { curlFetch } from "../curl-fetch";
import { processMirror } from "../commands/overview";

export const sessionsApi = new Hono();

// Whitelist of valid Oracle targets for POST /api/send.
// Matches src/api/dispatch.ts ORACLE_TARGETS exactly — "sofia" is intentionally
// excluded so that /api/send is never a path to the commander's pane.
// Sofia-bound messages must use the MCP thread channel, not this HTTP endpoint.
const ORACLE_SEND_TARGETS = new Set([
  "blade", "lens", "edge", "clip", "deck", "scope",
  "quill", "link", "bastion", "warden", "prism", "sage",
]);

function extractOracleName(target: string): string | null {
  const base = target.toLowerCase().trim().split(":")[0];
  const name = base.replace(/^\d+-/, "").replace(/-oracle$/, "");
  return ORACLE_SEND_TARGETS.has(name) ? name : null;
}

sessionsApi.get("/sessions", async (c) => {
  const local = await listSessions();
  if (c.req.query("local") === "true") {
    return c.json(local.map(s => ({ ...s, source: "local" })));
  }
  const aggregated = await getAggregatedSessions(local);
  return c.json(aggregated);
});

sessionsApi.get("/capture", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target required" }, 400);
  try {
    return c.json({ content: await capture(target) });
  } catch (e: any) {
    return c.json({ content: "", error: e.message });
  }
});

sessionsApi.get("/mirror", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.text("target required", 400);
  const lines = +(c.req.query("lines") || "40");
  const raw = await capture(target);
  return c.text(processMirror(raw, lines));
});

sessionsApi.post("/send", async (c) => {
  try {
    const { target, text } = await c.req.json();
    if (!target || !text) return c.json({ error: "target and text required" }, 400);
    if (typeof target !== "string") return c.json({ error: "target must be a string" }, 400);

    // Whitelist + normalize the target. From here on, the rest of the handler
    // must use `normalized` (a bare Oracle name) and never the raw client-
    // supplied `target`. The raw form can smuggle a "session:window" colon
    // address past the whitelist and reach arbitrary tmux panes
    // (Warden re-audit §3.1 bypass B).
    const normalized = extractOracleName(target);
    if (!normalized) {
      return c.json({ error: `target not allowed: ${target}` }, 403);
    }

    const local = await listSessions();

    // Step 1: Fuzzy resolve locally using the normalized Oracle name only —
    // never the raw client input. findWindow is called without allowRaw so
    // its colon-passthrough fallback is disabled for this code path.
    const resolved = findWindow(local, normalized);

    if (resolved) {
      await sendKeys(resolved, text);
      // Brief delay for tmux to process, then capture last line as delivery proof
      await Bun.sleep(150);
      let lastLine = "";
      try {
        const content = await capture(resolved, 3);
        lastLine = content.split("\n").filter(l => l.trim()).pop() || "";
      } catch {}
      return c.json({ ok: true, target: resolved, text, source: "local", lastLine });
    }

    // Step 2: Check agent registry for remote routing — keyed by normalized name.
    const config = loadConfig();
    const agentNode = config.agents?.[normalized];
    if (agentNode && agentNode !== (config.node ?? "local")) {
      const peer = config.namedPeers?.find(p => p.name === agentNode);
      const peerUrl = peer?.url || config.peers?.find(p => p.includes(agentNode));
      if (peerUrl) {
        const res = await curlFetch(`${peerUrl}/api/send`, {
          method: "POST",
          body: JSON.stringify({ target: normalized, text }),
          timeout: 10000,
        });
        if (res.ok && res.data?.ok) {
          return c.json({ ok: true, target: res.data.target || normalized, text, source: peerUrl, lastLine: res.data.lastLine || "" });
        }
        return c.json({ error: `Agent ${normalized} → ${agentNode} send failed`, target: normalized, source: peerUrl }, 502);
      }
    }

    // Step 3: Check peers via aggregated sessions — also keyed by normalized name.
    const peerUrl = await findPeerForTarget(normalized, local);
    if (peerUrl) {
      const ok = await sendKeysToPeer(peerUrl, normalized, text);
      if (ok) return c.json({ ok: true, target: normalized, text, source: peerUrl });
      return c.json({ error: "Failed to send to peer", target: normalized, source: peerUrl }, 502);
    }

    return c.json({ error: `target not found: ${target}`, target }, 404);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessionsApi.post("/select", async (c) => {
  const { target } = await c.req.json();
  if (!target) return c.json({ error: "target required" }, 400);
  await selectWindow(target);
  return c.json({ ok: true, target });
});
