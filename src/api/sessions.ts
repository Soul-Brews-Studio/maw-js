import { Hono } from "hono";
import { listSessions, capture, sendKeys, selectWindow } from "../ssh";
import { findWindow } from "../find-window";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../peers";
import { loadConfig } from "../config";
import { curlFetch } from "../curl-fetch";
import { processMirror } from "../commands/overview";

export const sessionsApi = new Hono();

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

    const local = await listSessions();

    // Step 1: Fuzzy resolve locally first
    const baseName = target.replace(/-oracle$/, "");
    const resolved = findWindow(local, target) || findWindow(local, baseName);

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

    // Step 2: Check agent registry for remote routing
    const config = loadConfig();
    const targetName = baseName.split(":").pop() || baseName;
    const agentNode = config.agents?.[targetName] || config.agents?.[target];
    if (agentNode && agentNode !== (config.node ?? "local")) {
      const peer = config.namedPeers?.find(p => p.name === agentNode);
      const peerUrl = peer?.url || config.peers?.find(p => p.includes(agentNode));
      if (peerUrl) {
        const res = await curlFetch(`${peerUrl}/api/send`, {
          method: "POST",
          body: JSON.stringify({ target, text }),
          timeout: 10000,
        });
        if (res.ok && res.data?.ok) {
          return c.json({ ok: true, target: res.data.target || target, text, source: peerUrl, lastLine: res.data.lastLine || "" });
        }
        return c.json({ error: `Agent ${targetName} → ${agentNode} send failed`, target, source: peerUrl }, 502);
      }
    }

    // Step 3: Check peers via aggregated sessions
    const peerUrl = await findPeerForTarget(target, local);
    if (peerUrl) {
      const ok = await sendKeysToPeer(peerUrl, target, text);
      if (ok) return c.json({ ok: true, target, text, source: peerUrl });
      return c.json({ error: "Failed to send to peer", target, source: peerUrl }, 502);
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
