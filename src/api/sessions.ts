import { Elysia, t} from "elysia";
import { listSessions, capture, sendKeys, selectWindow } from "../core/transport/ssh";
import { checkPaneIdle } from "../commands/shared/comm-send";
import { findWindow } from "../core/runtime/find-window";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../core/transport/peers";
import { loadConfig } from "../config";
import { curlFetch } from "../core/transport/curl-fetch";
import { resolveTarget } from "../core/routing";
import { processMirror } from "../commands/plugins/overview/impl";
import { resolveFleetSession } from "../commands/shared/wake";
import { WakeBody, SleepBody, SendBody, PaneKeysBody, ProbeBody } from "../lib/schemas";
import { Tmux } from "../core/transport/tmux";

export const sessionsApi = new Elysia();

/**
 * Dedupe windows within each session by window name (#732).
 *
 * When `config.agents` lists the same repo across multiple tmux windows,
 * `session.windows` can contain repeated entries with the same name. UI
 * consumers (mawui federation viz) iterate `session.windows` to render
 * one row per oracle — duplicates cause React key collisions.
 *
 * We keep the first occurrence per name, preferring the active window
 * when present so the "live" one wins. Shape is unchanged.
 */
export function dedupeSessionWindows<T extends { windows: { name: string; active?: boolean }[] }>(
  sessions: T[],
): T[] {
  return sessions.map(s => {
    const seen = new Map<string, typeof s.windows[number]>();
    for (const w of s.windows) {
      const existing = seen.get(w.name);
      if (!existing) {
        seen.set(w.name, w);
      } else if (!existing.active && w.active) {
        // Prefer the active window over an earlier non-active one
        seen.set(w.name, w);
      }
    }
    return { ...s, windows: [...seen.values()] };
  });
}

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
    return dedupeSessionWindows(local.map(s => ({ ...s, source: "local" })));
  }
  const aggregated = await getAggregatedSessions(local);
  return dedupeSessionWindows(aggregated);
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
    const { target, text, force, attachments } = body;
    const message = attachments?.length
      ? attachments.join("\n") + "\n" + text
      : text;

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
      // #405: idle guard — reject if user has in-progress input on the prompt line
      if (!force) {
        let idleCheck = await checkPaneIdle(resolved.target);
        if (!idleCheck.idle) {
          await Bun.sleep(500);
          idleCheck = await checkPaneIdle(resolved.target);
          if (!idleCheck.idle) {
            set.status = 409;
            return { ok: false, error: "pane not idle", target: resolved.target, lastInput: idleCheck.lastInput };
          }
        }
      }
      await sendKeys(resolved.target, message);
      await Bun.sleep(150);
      let lastLine = "";
      try { const content = await capture(resolved.target, 3); lastLine = content.split("\n").filter(l => l.trim()).pop() || ""; } catch {}
      return { ok: true, target: resolved.target, text, source: "local", lastLine };
    }

    // Remote peer → federation HTTP
    if (resolved?.type === "peer") {
      const res = await curlFetch(`${resolved.peerUrl}/api/send`, {
        method: "POST",
        body: JSON.stringify({ target: resolved.target, text: message }),
        timeout: 10000,
        from: "auto", // #804 Step 4 SIGN — sign cross-node forwarded /api/send
      });
      if (res.ok && res.data?.ok) {
        return { ok: true, target: res.data.target || target, text, source: resolved.peerUrl, lastLine: res.data.lastLine || "" };
      }
      set.status = 502; return { error: `${resolved.node} → ${resolved.target} send failed`, target, source: resolved.peerUrl };
    }

    // Fallback: async peer discovery
    const peerUrl = await findPeerForTarget(target, local);
    if (peerUrl) {
      const ok = await sendKeysToPeer(peerUrl, target, message);
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

/**
 * POST /api/pane-keys — raw send-keys to any tmux pane (#757).
 *
 * Body: { target, text, enter? }
 *   - text is sent literally via `tmux send-keys -l` (no paste-mode, no
 *     interpretation of special chars like |). Empty text is allowed.
 *   - enter=true appends `tmux send-keys Enter` after the text.
 *
 * No readiness guard, no paste delay — this is the dual of `maw send-enter`.
 * Used by `maw send` (enter=false) and `maw run` (enter=true) cross-node.
 */
sessionsApi.post("/pane-keys", async ({ body, set }) => {
  try {
    const { target, text, enter } = body;
    if (!target) { set.status = 400; return { error: "target required" }; }
    const t = new Tmux();
    if (text && text.length > 0) {
      await t.sendKeysLiteral(target, text);
    }
    if (enter) {
      await t.sendKeys(target, "Enter");
    }
    return { ok: true, target, enter: !!enter };
  } catch (err) {
    set.status = 500; return { error: String(err) };
  }
}, {
  body: PaneKeysBody,
});

/**
 * POST /api/probe — real-write-path health check (#804 Step 5).
 *
 * Walks the same resolveTarget/tmux-session-exists branches as /api/send but
 * stops short of `sendKeys` — never mutates a pane. With no `target`, only
 * proves the handler can run (config loads, listSessions returns) so peers
 * can confirm reachability without naming a deliverable agent.
 *
 * Auth: federationAuth + fromSigningAuth (it's a write-path endpoint — same
 * surface as /send, /wake). Loopback is exempted via the same gate. Callers
 * sign with `from: "auto"` so peer continuity (Step 4) is exercised too.
 *
 * Response shape:
 *   - { ok: true, target?, transport: "local"|"ssh", source }
 *   - { ok: false, error, target? } with HTTP 4xx/5xx
 *
 * Lesson banked from #795 schema-drift: /api/identity returning 200 doesn't
 * mean /api/send works — different code paths fail independently. /probe
 * exercises the same writer-side branches /send does, so green here means
 * green for delivery (modulo the actual sendKeys, which is the only step we
 * skip). See ADR docs/federation/0001-peer-identity.md.
 */
sessionsApi.post("/probe", async ({ body, set }) => {
  try {
    const target = body?.target;

    // Bare healthcheck — no target. Just prove we can walk the write path
    // setup (loadConfig + listSessions). If either throws, /send would too.
    if (!target) {
      const config = loadConfig();
      const local = await listSessions();
      return {
        ok: true,
        transport: "local" as const,
        source: config.node ?? "local",
        sessions: local.length,
      };
    }

    const config = loadConfig();
    const local = await listSessions();

    // Same resolution as /send — including the -oracle stripped retry — so a
    // probe failure here means /send would fail with the same reason.
    const result = resolveTarget(target, config, local);
    const isResolved = result && result.type !== "error";
    const altResult = !isResolved ? resolveTarget(target.replace(/-oracle$/, ""), config, local) : null;
    const altResolved = altResult && altResult.type !== "error";
    const resolved = isResolved ? result : altResolved ? altResult : (result || altResult);

    if (resolved?.type === "local" || resolved?.type === "self-node") {
      // Validate the tmux session in `<session>:<window>` actually exists.
      // resolveTarget already implies the window resolved, but a probe should
      // confirm the tmux server still answers (the #795-style failure mode).
      const sessionName = resolved.target.split(":")[0] ?? "";
      const sessionExists = local.some(s => s.name === sessionName);
      if (!sessionExists) {
        set.status = 404;
        return { ok: false, error: `tmux session not found: ${sessionName}`, target };
      }
      return {
        ok: true,
        target: resolved.target,
        transport: "local" as const,
        source: config.node ?? "local",
      };
    }

    if (resolved?.type === "peer") {
      // We don't forward the probe further — that's the caller's job. Report
      // that this node would forward to <peerUrl> if /send were called.
      return {
        ok: true,
        target: resolved.target,
        transport: "ssh" as const,
        source: resolved.peerUrl,
        node: resolved.node,
      };
    }

    const errDetail = resolved?.type === "error"
      ? { reason: resolved.reason, detail: resolved.detail, hint: resolved.hint }
      : {};
    set.status = 404;
    return { ok: false, error: `target not found: ${target}`, target, ...errDetail };
  } catch (err) {
    set.status = 500;
    return { ok: false, error: String(err) };
  }
}, {
  body: ProbeBody,
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
    const target = body.target ?? body.oracle;
    if (!target) { set.status = 400; return { error: "target required (or 'oracle' for legacy peers)" }; }
    const { cmdWake } = await import("../commands/shared/wake");
    await cmdWake(target, { noAttach: true, task: body.task });
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
    const { cmdSleepOne } = await import("../commands/plugins/sleep/impl");
    await cmdSleepOne(target);
    return { ok: true, target };
  } catch (err) {
    set.status = 500; return { error: String(err) };
  }
}, {
  body: SleepBody,
});
