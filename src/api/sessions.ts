import { Hono } from "hono";
import { listSessions, capture, sendKeys, selectWindow } from "../ssh";
import { findWindow } from "../find-window";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../peers";
import { loadConfig } from "../config";
import { curlFetch } from "../curl-fetch";
import { resolveTarget } from "../routing";
import { processMirror } from "../commands/overview";

export const sessionsApi = new Hono();

const TARGET_SAFE_CHARS = /^[a-zA-Z0-9:._-]{1,64}$/;

function validateTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!TARGET_SAFE_CHARS.test(raw)) return null;
  return raw;
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
  const target = validateTarget(c.req.query("target"));
  if (!target) return c.json({ error: "target required or invalid" }, 400);
  try {
    return c.json({ content: await capture(target) });
  } catch (e: any) {
    return c.json({ content: "", error: e.message });
  }
});

sessionsApi.get("/mirror", async (c) => {
  const target = validateTarget(c.req.query("target"));
  if (!target) return c.text("target required or invalid", 400);
  const lines = +(c.req.query("lines") || "40");
  const raw = await capture(target);
  return c.text(processMirror(raw, lines));
});

sessionsApi.post("/send", async (c) => {
  try {
    const body = await c.req.json();
    const target = validateTarget(body.target);
    const text = body.text;
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
