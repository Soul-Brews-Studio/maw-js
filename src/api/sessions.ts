import { Hono } from "hono";
import { listSessions, capture, sendKeys, selectWindow } from "../ssh";
import { findWindow } from "../find-window";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../peers";
import { loadConfig } from "../config";
import { curlFetch } from "../curl-fetch";
import { resolveTarget } from "../routing";
import { processMirror } from "../commands/overview";
import { resolveFleetSession } from "../commands/wake";

export const sessionsApi = new Hono();

/** Resolve oracle name → tmux target, same logic as local peek (#273). */
function resolveCapture(query: string, sessions: { name: string }[]): string {
  const config = loadConfig();
  const mapped = (config.sessions as Record<string, string>)?.[query];
  if (mapped) {
    const filtered = sessions.filter(s => s.name === mapped);
    if (filtered.length > 0) return findWindow(filtered, query) || query;
  }
  const fleetSession = resolveFleetSession(query);
  if (fleetSession) {
    const filtered = sessions.filter(s => s.name === fleetSession);
    if (filtered.length > 0) return findWindow(filtered, query) || query;
  }
  return findWindow(sessions, query) || query;
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
    const sessions = await listSessions();
    const resolved = resolveCapture(target, sessions);
    return c.json({ content: await capture(resolved) });
  } catch (e: any) {
    return c.json({ content: "", error: e.message });
  }
});

sessionsApi.get("/mirror", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.text("target required", 400);
  const lines = +(c.req.query("lines") || "40");
  const sessions = await listSessions();
  const resolved = resolveCapture(target, sessions);
  const raw = await capture(resolved);
  return c.text(processMirror(raw, lines));
});

sessionsApi.post("/send", async (c) => {
  try {
    const { target, text } = await c.req.json();
    if (!target || !text) return c.json({ error: "target and text required" }, 400);

    const config = loadConfig();
    const local = await listSessions();

    // --- Unified resolution via resolveTarget (#201) ---
    const result = resolveTarget(target, config, local);

    // Also try with -oracle stripped (backwards compat)
    const isResolved = result && result.type !== "error";
    const altResult = !isResolved ? resolveTarget(target.replace(/-oracle$/, ""), config, local) : null;
    const altResolved = altResult && altResult.type !== "error";
    const resolved = isResolved ? result : altResolved ? altResult : (result || altResult);

    // Local or self-node → send via tmux
    if (resolved?.type === "local" || resolved?.type === "self-node") {
      await sendKeys(resolved.target, text);
      await Bun.sleep(150);
      let lastLine = "";
      try { const content = await capture(resolved.target, 3); lastLine = content.split("\n").filter(l => l.trim()).pop() || ""; } catch {}
      return c.json({ ok: true, target: resolved.target, text, source: "local", lastLine });
    }

    // Remote peer → federation HTTP
    if (resolved?.type === "peer") {
      const res = await curlFetch(`${resolved.peerUrl}/api/send`, {
        method: "POST",
        body: JSON.stringify({ target: resolved.target, text }),
        timeout: 10000,
      });
      if (res.ok && res.data?.ok) {
        return c.json({ ok: true, target: res.data.target || target, text, source: resolved.peerUrl, lastLine: res.data.lastLine || "" });
      }
      return c.json({ error: `${resolved.node} → ${resolved.target} send failed`, target, source: resolved.peerUrl }, 502);
    }

    // Fallback: async peer discovery
    const peerUrl = await findPeerForTarget(target, local);
    if (peerUrl) {
      const ok = await sendKeysToPeer(peerUrl, target, text);
      if (ok) return c.json({ ok: true, target, text, source: peerUrl });
      return c.json({ error: "Failed to send to peer", target, source: peerUrl }, 502);
    }

    const errDetail = resolved?.type === "error" ? { reason: resolved.reason, detail: resolved.detail, hint: resolved.hint } : {};
    return c.json({ error: `target not found: ${target}`, target, ...errDetail }, 404);
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

sessionsApi.post("/wake", async (c) => {
  try {
    const { target, task } = await c.req.json();
    if (!target) return c.json({ error: "target required" }, 400);
    const { cmdWake } = await import("../commands/wake");
    await cmdWake(target, { noAttach: true, task });
    return c.json({ ok: true, target });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessionsApi.post("/sleep", async (c) => {
  try {
    const { target } = await c.req.json();
    if (!target) return c.json({ error: "target required" }, 400);
    const { cmdSleepOne } = await import("../commands/sleep");
    await cmdSleepOne(target);
    return c.json({ ok: true, target });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
