import { Elysia, t} from "elysia";
import { listSessions, capture, sendKeys, selectWindow } from "../ssh";
import { findWindow } from "../find-window";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../peers";
import { loadConfig } from "../config";
import { curlFetch } from "../curl-fetch";
import { resolveTarget } from "../routing";
import { processMirror } from "../commands/overview";
import { resolveFleetSession } from "../commands/wake";
import { WakeBody, SleepBody, SendBody } from "../lib/schemas";

export const sessionsApi = new Elysia();

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

sessionsApi.get("/sessions", async ({ query }) => {
  const local = await listSessions();
  if (query.local === "true") {
    return local.map(s => ({ ...s, source: "local" }));
  }
  const aggregated = await getAggregatedSessions(local);
  return aggregated;
}, {
  query: t.Object({
    local: t.Optional(t.String()),
  }),
});

sessionsApi.get("/capture", async ({ query, set}) => {
  const target = query.target;
  if (!target) { set.status = 400; return { error: "target required" }; }
  try {
    const sessions = await listSessions();
    const resolved = resolveCapture(target, sessions);
    return { content: await capture(resolved) };
  } catch (e: any) {
    return { content: "", error: e.message };
  }
}, {
  query: t.Object({
    target: t.Optional(t.String()),
  }),
});

sessionsApi.get("/mirror", async ({ query, set}) => {
  const target = query.target;
  if (!target) { set.status = 400; return "target required"; }
  const lines = +(query.lines || "40");
  const sessions = await listSessions();
  const resolved = resolveCapture(target, sessions);
  const raw = await capture(resolved);
  return processMirror(raw, lines);
}, {
  query: t.Object({
    target: t.Optional(t.String()),
    lines: t.Optional(t.String()),
  }),
});

sessionsApi.post("/send", async ({ body, set}) => {
  try {
    const { target, text } = body;

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
      return { ok: true, target: resolved.target, text, source: "local", lastLine };
    }

    // Remote peer → federation HTTP
    if (resolved?.type === "peer") {
      const res = await curlFetch(`${resolved.peerUrl}/api/send`, {
        method: "POST",
        body: JSON.stringify({ target: resolved.target, text }),
        timeout: 10000,
      });
      if (res.ok && res.data?.ok) {
        return { ok: true, target: res.data.target || target, text, source: resolved.peerUrl, lastLine: res.data.lastLine || "" };
      }
      set.status = 502; return { error: `${resolved.node} → ${resolved.target} send failed`, target, source: resolved.peerUrl };
    }

    // Fallback: async peer discovery
    const peerUrl = await findPeerForTarget(target, local);
    if (peerUrl) {
      const ok = await sendKeysToPeer(peerUrl, target, text);
      if (ok) return { ok: true, target, text, source: peerUrl };
      set.status = 502; return { error: "Failed to send to peer", target, source: peerUrl };
    }

    const errDetail = resolved?.type === "error" ? { reason: resolved.reason, detail: resolved.detail, hint: resolved.hint } : {};
    set.status = 404; return { error: `target not found: ${target}`, target, ...errDetail };
  } catch (err) {
    set.status = 500; return { error: String(err) };
  }
}, {
  body: SendBody,
});

sessionsApi.post("/select", async ({ body, set}) => {
  const { target } = body;
  if (!target) { set.status = 400; return { error: "target required" }; }
  await selectWindow(target);
  return { ok: true, target };
}, {
  body: t.Object({ target: t.String() }),
});

sessionsApi.post("/wake", async ({ body, set}) => {
  try {
    const { target, task } = body;
    const { cmdWake } = await import("../commands/wake");
    await cmdWake(target, { noAttach: true, task });
    return { ok: true, target };
  } catch (err) {
    set.status = 500; return { error: String(err) };
  }
}, {
  body: WakeBody,
});

sessionsApi.post("/sleep", async ({ body, set}) => {
  try {
    const { target } = body;
    const { cmdSleepOne } = await import("../commands/sleep");
    await cmdSleepOne(target);
    return { ok: true, target };
  } catch (err) {
    set.status = 500; return { error: String(err) };
  }
}, {
  body: SleepBody,
});
