import { Hono } from "hono";
import { listSessions, capture, sendKeys, selectWindow, findWindow } from "../ssh";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../peers";
import { loadConfig } from "../config";
import { curlFetch } from "../curl-fetch";
import { processMirror } from "../commands/overview";

export const sessionsApi = new Hono();

/**
 * Normalize an Oracle target name: strip numeric prefix, "-oracle" suffix,
 * and the tmux "session:window" suffix if present. The result feeds
 * findWindow() for fuzzy pane resolution.
 *
 * No whitelist. listSessions() + findWindow() are the security boundary —
 * if the normalized name does not resolve to a live tmux pane, the handler
 * falls through to 404. Matches the Soul-Brews-Studio/maw-js upstream
 * pattern; the prior ORACLE_SEND_TARGETS whitelist broke the reply-ping
 * protocol by rejecting `target=00-sofia` from every peer Oracle.
 */
function normalizeOracleName(target: string): string {
  const base = target.toLowerCase().trim().split(":")[0];
  return base.replace(/^\d+-/, "").replace(/-oracle$/, "");
}

/**
 * Strict shape check for the raw client-supplied `target` string before it
 * reaches any of the ssh()-based helpers in ../ssh (capture, selectWindow,
 * sendKeys). The helpers still interpolate the target into a shell string
 * as of Round 4 — the durable argv-form refactor for src/ssh.ts is
 * scheduled for Round 5. Until then, this regex is the gate that keeps
 * shell metacharacters out of the helper layer.
 *
 * Allowed: ASCII alphanumerics, dash, underscore, dot, colon. Length
 * bounded to 64. Anchored, no backtracking risk.
 *
 * Explicitly rejects (all of which Warden R9 bonus-audit called out):
 *   quotes ('  "), backtick (`), dollar ($), parentheses ( )
 *   semicolon (;), ampersand (&), pipe (|), redirection (< >)
 *   whitespace, slash (/), backslash (\), hash (#), newlines
 */
const TARGET_SAFE_CHARS = /^[a-zA-Z0-9:._-]{1,64}$/;

/**
 * Strict shape check for the Oracle slug produced by normalizeOracleName().
 * After normalization the string should be a bare Oracle name (e.g. "sofia",
 * "blade", "01-blade" -> "blade"). This guard rejects anything that does not
 * match that shape, as a defense-in-depth layer above findWindow().
 */
const NORMALIZED_NAME_SHAPE = /^[a-z0-9-]{1,32}$/;

/**
 * Two-layer validation used by /capture, /mirror, and /send. Returns the
 * original, now-known-safe target string on success so tmux
 * session:window semantics are preserved. Returns null on any failure.
 */
function validateTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!TARGET_SAFE_CHARS.test(raw)) return null;
  const normalized = normalizeOracleName(raw);
  if (!NORMALIZED_NAME_SHAPE.test(normalized)) return null;
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
  const safe = validateTarget(c.req.query("target"));
  if (!safe) return c.json({ error: "invalid target" }, 400);
  try {
    return c.json({ content: await capture(safe) });
  } catch {
    // Do not echo e.message — tmux / ssh error output can contain
    // user-supplied substrings from the target, even after validation.
    return c.json({ content: "", error: "capture failed" });
  }
});

sessionsApi.get("/mirror", async (c) => {
  const safe = validateTarget(c.req.query("target"));
  if (!safe) return c.text("invalid target", 400);
  const lines = +(c.req.query("lines") || "40");
  const raw = await capture(safe);
  return c.text(processMirror(raw, lines));
});

sessionsApi.post("/send", async (c) => {
  try {
    const { target, text } = await c.req.json();
    if (!target || !text) return c.json({ error: "target and text required" }, 400);
    if (typeof target !== "string") return c.json({ error: "target must be a string" }, 400);

    // Shape-check the raw target with the same TARGET_SAFE_CHARS regex used
    // by /capture and /mirror. This is defense-in-depth against anyone who
    // POSTs a metacharacter-laden target that passes JSON parsing but could
    // still confuse downstream consumers (curlFetch forwarding to peers,
    // error echoes, logs).
    if (!TARGET_SAFE_CHARS.test(target)) {
      return c.json({ error: "invalid target" }, 400);
    }

    // Normalize the raw client-supplied target into a bare Oracle name. From
    // here on, the rest of the handler must use `normalized` and never the
    // raw `target` — that is what keeps Warden §3.1 bypass B (colon smuggle)
    // closed, since findWindow is invoked without `allowRaw` and the raw
    // "session:window" form never reaches tmux.
    const normalized = normalizeOracleName(target);
    if (!NORMALIZED_NAME_SHAPE.test(normalized)) {
      // Stricter than the pre-R4 empty-check: the normalized slug must
      // match the same shape /capture + /mirror require. Defense-in-depth
      // above findWindow() and Path A' live-session lookup.
      return c.json({ error: "invalid target" }, 400);
    }

    const local = await listSessions();

    // Step 1: Fuzzy resolve locally using the normalized Oracle name against
    // the live session list. findWindow is called without allowRaw so its
    // colon-passthrough fallback is disabled. If nothing matches, the
    // handler falls through to the peer paths and eventually to 404 —
    // listSessions() is the security boundary, matching Nat upstream.
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
