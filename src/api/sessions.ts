import { Hono } from "hono";
import { listSessions, capture, sendKeys, selectWindow, findWindow } from "../ssh";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../peers";
import { loadConfig } from "../config";
import { curlFetch } from "../curl-fetch";
import { processMirror } from "../commands/overview";

export const sessionsApi = new Hono();

sessionsApi.get("/sessions", async (c) => {
  const local = await listSessions();
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
  const { target, text } = await c.req.json();
  if (!target || !text) return c.json({ error: "target and text required" }, 400);

  // Check if target is on a peer
  const local = await listSessions();
  const peerUrl = await findPeerForTarget(target, local);

  if (peerUrl) {
    // Route to peer (found via session aggregation)
    const ok = await sendKeysToPeer(peerUrl, target, text);
    if (ok) return c.json({ ok: true, target, text, source: peerUrl });
    return c.json({ error: "Failed to send to peer", target, source: peerUrl }, 502);
  }

  // Check agent registry — direct routing via config
  const config = loadConfig();
  const targetName = target.replace(/-oracle$/, "").split(":").pop() || target;
  const agentNode = config.agents?.[targetName] || config.agents?.[target];
  if (agentNode && agentNode !== (config.node || config.host || "local")) {
    const peer = config.namedPeers?.find(p => p.name === agentNode);
    const peerUrl2 = peer?.url || config.peers?.find(p => p.includes(agentNode));
    if (peerUrl2) {
      const res = await curlFetch(`${peerUrl2}/api/send`, {
        method: "POST",
        body: JSON.stringify({ target, text }),
        timeout: 10000,
      });
      if (res.ok && res.data?.ok) {
        return c.json({ ok: true, target: res.data.target || target, text, source: peerUrl2 });
      }
      return c.json({ error: `Agent ${targetName} mapped to ${agentNode} but send failed`, target, source: peerUrl2 }, 502);
    }
  }

  // Send locally — try exact target first, then fuzzy match
  const resolved = findWindow(local, target) || target;
  try {
    await sendKeys(resolved, text);
    return c.json({ ok: true, target: resolved, text, source: "local" });
  } catch {
    return c.json({ error: `target not found: ${target}`, target }, 404);
  }
});

sessionsApi.post("/select", async (c) => {
  const { target } = await c.req.json();
  if (!target) return c.json({ error: "target required" }, 400);
  await selectWindow(target);
  return c.json({ ok: true, target });
});
