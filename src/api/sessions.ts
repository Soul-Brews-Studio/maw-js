import { Elysia, t } from "elysia";
import { listSessions, capture, sendKeys, selectWindow } from "../core/transport/ssh";
import { checkPaneIdle } from "../commands/shared/comm-send";
import { findWindow } from "../core/runtime/find-window";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer, sendKeysToPeerDetailed } from "../core/transport/peers";
import { loadConfig } from "../config";
import { curlFetch } from "../core/transport/curl-fetch";
import { resolveTarget } from "../core/routing";
import { processMirror } from "../lib/process-mirror";
import { cmdWake as defaultCmdWake, resolveFleetSession } from "../commands/shared/wake";
import { shouldAutoWake as defaultShouldAutoWake } from "../commands/shared/should-auto-wake";
import { cmdSleepOne as defaultCmdSleepOne } from "../lib/sleep";
import { WakeBody, SleepBody, SendBody, PaneKeysBody, ProbeBody } from "../lib/schemas";
import { Tmux } from "../core/transport/tmux";
import { pushFeedEvent } from "./feed";
import { buildMessageLifecycleFeedEvent, type MessageLifecycleInput } from "../lib/message-events";
import { defaultReceiverInboxWriter, type ReceiverInboxResult, type ReceiverInboxWriter } from "../commands/shared/receiver-inbox";
import type { Session } from "../core/transport/ssh";

type Config = ReturnType<typeof loadConfig>;
type IdleCheck = Awaited<ReturnType<typeof checkPaneIdle>>;
type TmuxLike = Pick<Tmux, "sendKeysLiteral" | "sendKeys">;

type AutoWakeDecision = Awaited<ReturnType<typeof defaultShouldAutoWake>>;
type AutoWakeOpts = Parameters<typeof defaultShouldAutoWake>[1];

export interface SessionsApiDeps {
  listSessions?: typeof listSessions;
  capture?: typeof capture;
  sendKeys?: typeof sendKeys;
  selectWindow?: typeof selectWindow;
  checkPaneIdle?: typeof checkPaneIdle;
  findWindow?: typeof findWindow;
  getAggregatedSessions?: typeof getAggregatedSessions;
  findPeerForTarget?: typeof findPeerForTarget;
  sendKeysToPeer?: typeof sendKeysToPeer;
  sendKeysToPeerDetailed?: typeof sendKeysToPeerDetailed;
  loadConfig?: typeof loadConfig;
  curlFetch?: typeof curlFetch;
  resolveTarget?: typeof resolveTarget;
  processMirror?: typeof processMirror;
  resolveFleetSession?: typeof resolveFleetSession;
  createTmux?: () => TmuxLike;
  pushFeedEvent?: typeof pushFeedEvent;
  buildMessageLifecycleFeedEvent?: typeof buildMessageLifecycleFeedEvent;
  emitMessageLifecycle?: (input: MessageLifecycleInput) => void;
  writeReceiverInbox?: ReceiverInboxWriter | null;
  sleep?: (ms: number) => Promise<unknown>;
  shouldAutoWake?: (target: string, opts: AutoWakeOpts) => AutoWakeDecision | Promise<AutoWakeDecision>;
  cmdWake?: (target: string, opts: { noAttach: boolean; task?: string }) => Promise<unknown>;
  cmdSleepOne?: (target: string) => Promise<unknown>;
}

function defaults(deps: SessionsApiDeps) {
  return {
    listSessions: deps.listSessions ?? listSessions,
    capture: deps.capture ?? capture,
    sendKeys: deps.sendKeys ?? sendKeys,
    selectWindow: deps.selectWindow ?? selectWindow,
    checkPaneIdle: deps.checkPaneIdle ?? checkPaneIdle,
    findWindow: deps.findWindow ?? findWindow,
    getAggregatedSessions: deps.getAggregatedSessions ?? getAggregatedSessions,
    findPeerForTarget: deps.findPeerForTarget ?? findPeerForTarget,
    sendKeysToPeer: deps.sendKeysToPeer ?? sendKeysToPeer,
    sendKeysToPeerDetailed: deps.sendKeysToPeerDetailed ?? sendKeysToPeerDetailed,
    loadConfig: deps.loadConfig ?? loadConfig,
    curlFetch: deps.curlFetch ?? curlFetch,
    resolveTarget: deps.resolveTarget ?? resolveTarget,
    processMirror: deps.processMirror ?? processMirror,
    resolveFleetSession: deps.resolveFleetSession ?? resolveFleetSession,
    createTmux: deps.createTmux ?? (() => new Tmux()),
    pushFeedEvent: deps.pushFeedEvent ?? pushFeedEvent,
    buildMessageLifecycleFeedEvent: deps.buildMessageLifecycleFeedEvent ?? buildMessageLifecycleFeedEvent,
    emitMessageLifecycle: deps.emitMessageLifecycle,
    writeReceiverInbox: deps.writeReceiverInbox === undefined ? defaultReceiverInboxWriter() : deps.writeReceiverInbox,
    sleep: deps.sleep ?? ((ms: number) => Bun.sleep(ms)),
    shouldAutoWake: deps.shouldAutoWake ?? defaultShouldAutoWake,
    cmdWake: deps.cmdWake ?? defaultCmdWake,
    cmdSleepOne: deps.cmdSleepOne ?? defaultCmdSleepOne,
  };
}

export function localMessageIdentity(config: Config): string {
  return `${config.node ?? "local"}:${config.oracle ?? "mawjs"}`;
}

export function requestMessageFrom(request: Request, config: Config): string {
  const from = request.headers.get("x-maw-from");
  if (!from) return localMessageIdentity(config);
  // Wire auth uses <oracle>:<node>; user-facing/message ledger uses <node>:<oracle>.
  const idx = from.indexOf(":");
  if (idx > 0 && idx < from.length - 1) return `${from.slice(idx + 1)}:${from.slice(0, idx)}`;
  return from;
}

export function messageSignedRequest(request: Request): boolean {
  return Boolean(request.headers.get("x-maw-from"));
}

function stripPaneIndex(target: string): string {
  return target.replace(/\.[0-9]+$/, "");
}

export function sessionTargetExists(sessions: Session[], target: string): boolean {
  const normalized = stripPaneIndex(target.trim());
  if (!normalized) return false;
  const [sessionName, windowName] = normalized.split(":", 2);
  const session = sessions.find(s => s.name === sessionName);
  if (!session) return false;
  if (!windowName) return true;
  return session.windows.some(w => String(w.index) === windowName || w.name === windowName);
}

export function emitMessageLifecycle(input: MessageLifecycleInput, deps: SessionsApiDeps = {}) {
  try {
    const build = deps.buildMessageLifecycleFeedEvent ?? buildMessageLifecycleFeedEvent;
    const push = deps.pushFeedEvent ?? pushFeedEvent;
    push(build(input));
  } catch {
    // Ledger/event hooks must never change /api/send delivery semantics.
  }
}

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

function sessionsUnavailablePayload(error: unknown): { error: string; hint?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const payload: { error: string; hint?: string } = { error: `tmux unavailable: ${message}` };
  if (/tmux: command not found/i.test(message) || /command not found: tmux/i.test(message) || /exit 127/.test(message)) {
    payload.hint = "tmux command not found; when maw runs under pm2 on Apple Silicon, restart with PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH pm2 restart maw --update-env && pm2 save";
  }
  return payload;
}

/** Resolve oracle name → tmux target, same logic as local peek (#273). */
export function resolveCapture(query: string, sessions: { name: string }[], deps: SessionsApiDeps = {}): string {
  const d = defaults(deps);
  const config = d.loadConfig();
  const mapped = (config.sessions as Record<string, string>)?.[query];
  if (mapped) {
    const filtered = sessions.filter(s => s.name === mapped);
    if (filtered.length > 0) return d.findWindow(filtered, query) || query;
  }
  const fleetSession = d.resolveFleetSession(query);
  if (fleetSession) {
    const filtered = sessions.filter(s => s.name === fleetSession);
    if (filtered.length > 0) return d.findWindow(filtered, query) || query;
  }
  return d.findWindow(sessions, query) || query;
}

export function createSessionsApi(deps: SessionsApiDeps = {}) {
  const d = defaults(deps);
  const emitLifecycle = d.emitMessageLifecycle ?? ((input: MessageLifecycleInput) => emitMessageLifecycle(input, d));
  const api = new Elysia();

  api.get("/sessions", async ({ query, set }) => {
    let local: Session[];
    try {
      local = await d.listSessions();
    } catch (error) {
      set.status = 503;
      return sessionsUnavailablePayload(error);
    }
    if (query.local === "true") {
      return dedupeSessionWindows(local.map(s => ({ ...s, source: "local" })));
    }
    const aggregated = await d.getAggregatedSessions(local);
    return dedupeSessionWindows(aggregated);
  }, {
    query: t.Object({
      local: t.Optional(t.String()),
    }),
  });

  api.get("/capture", async ({ query, set }) => {
    const target = query.target;
    if (!target) { set.status = 400; return { error: "target required" }; }
    try {
      const sessions = await d.listSessions();
      const resolved = resolveCapture(target, sessions, d);
      return { content: await d.capture(resolved) };
    } catch (e: any) {
      return { content: "", error: e.message };
    }
  }, {
    query: t.Object({
      target: t.Optional(t.String()),
    }),
  });

  api.get("/mirror", async ({ query, set }) => {
    const target = query.target;
    if (!target) { set.status = 400; return "target required"; }
    const lines = +(query.lines || "40");
    const sessions = await d.listSessions();
    const resolved = resolveCapture(target, sessions, d);
    const raw = await d.capture(resolved);
    return d.processMirror(raw, lines);
  }, {
    query: t.Object({
      target: t.Optional(t.String()),
      lines: t.Optional(t.String()),
    }),
  });

  api.post("/send", async ({ body, request, set }) => {
    try {
      const { target, text, force, attachments } = body;
      const message = attachments?.length
        ? attachments.join("\n") + "\n" + text
        : text;

      const config = d.loadConfig();
      const messageFrom = requestMessageFrom(request, config);
      const messageTo = localMessageIdentity(config);
      const messageSigned = messageSignedRequest(request);
      let local: Session[] = [];
      let localListError: unknown = null;
      try {
        local = await d.listSessions();
      } catch (error) {
        localListError = error;
      }
      const writeInboundInbox = async (tmuxTarget?: string): Promise<ReceiverInboxResult | null> => {
        if (!d.writeReceiverInbox) return null;
        try {
          return await d.writeReceiverInbox({
            query: target,
            target: tmuxTarget,
            to: target,
            from: messageFrom,
            message,
            config,
          });
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
      };
      const queuedInboxResponse = (inbox: ReceiverInboxResult, tmuxTarget: string, reason: string) => {
        if (!inbox.ok) return null;
        emitLifecycle({
          direction: "inbound",
          state: "queued",
          channel: "api-send",
          route: "inbox",
          from: messageFrom,
          to: `${config.node ?? "local"}:${inbox.oracle}`,
          target: tmuxTarget,
          text: message,
          lastLine: reason,
          signed: messageSigned,
        });
        return {
          ok: true,
          target: tmuxTarget,
          text,
          source: "inbox",
          state: "queued" as const,
          inbox: inbox.path,
          reason,
        };
      };
      const queueOrFail = async (tmuxTarget: string, reason: string, status = 502) => {
        const inbox = await writeInboundInbox(tmuxTarget);
        const queued = inbox ? queuedInboxResponse(inbox, tmuxTarget, reason) : null;
        if (queued) return queued;
        set.status = status;
        emitLifecycle({
          direction: "inbound",
          state: "failed",
          channel: "api-send",
          route: "local",
          from: messageFrom,
          to: messageTo,
          target: tmuxTarget,
          text: message,
          error: reason,
          signed: messageSigned,
        });
        return { ok: false, error: reason, target: tmuxTarget };
      };
      const verifyDeliverableTarget = async (tmuxTarget: string) => {
        if (localListError) {
          const msg = localListError instanceof Error ? localListError.message : String(localListError);
          return { ok: false as const, reason: `tmux unavailable: ${msg}` };
        }
        try {
          const fresh = await d.listSessions();
          return sessionTargetExists(fresh, tmuxTarget)
            ? { ok: true as const }
            : { ok: false as const, reason: `target not live in tmux: ${tmuxTarget}` };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { ok: false as const, reason: `tmux unavailable: ${msg}` };
        }
      };

      // --- Unified resolution via resolveTarget (#201) ---
      const result = d.resolveTarget(target, config, local);

      // Also try with -oracle stripped (backwards compat)
      const isResolved = result && result.type !== "error";
      const altResult = !isResolved ? d.resolveTarget(target.replace(/-oracle$/, ""), config, local) : null;
      const altResolved = altResult && altResult.type !== "error";
      const resolved = isResolved ? result : altResolved ? altResult : (result || altResult);

      // Local or self-node → send via tmux
      if (resolved?.type === "local" || resolved?.type === "self-node") {
        const live = await verifyDeliverableTarget(resolved.target);
        if (!live.ok) return queueOrFail(resolved.target, live.reason);
        // #405: idle guard — reject if user has in-progress input on the prompt line
        try {
          if (!force) {
            let idleCheck = await d.checkPaneIdle(resolved.target);
            if (!idleCheck.idle) {
              await d.sleep(500);
              idleCheck = await d.checkPaneIdle(resolved.target);
              if (!idleCheck.idle) {
                const inbox = await writeInboundInbox(resolved.target);
                const queued = inbox ? queuedInboxResponse(inbox, resolved.target, "pane not idle") : null;
                if (queued) return queued;
                set.status = 409;
                emitLifecycle({
                  direction: "inbound",
                  state: "failed",
                  channel: "api-send",
                  route: resolved.type,
                  from: messageFrom,
                  to: messageTo,
                  target: resolved.target,
                  text: message,
                  error: "pane not idle",
                  lastLine: idleCheck.lastInput,
                  signed: messageSigned,
                });
                return { ok: false, error: "pane not idle", target: resolved.target, lastInput: idleCheck.lastInput };
              }
            }
          }
          await d.sendKeys(resolved.target, message);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return queueOrFail(resolved.target, `tmux delivery failed: ${msg}`);
        }
        const inbox = await writeInboundInbox(resolved.target);
        await d.sleep(150);
        let lastLine = "";
        // Echo broadcast bug 2026-04-26: claude queues input behind a busy prompt and
        // tmux send-keys still succeeds, so callers think delivery worked. Detect the
        // "Press up to edit queued messages" indicator so the API can distinguish
        // delivered vs queued.
        let state: "delivered" | "queued" = "delivered";
        try {
          const content = await d.capture(resolved.target, 8);
          const lines = content.split("\n").filter(l => l.trim());
          lastLine = lines.pop() || "";
          if (/Press up to edit queued messages/i.test(content)) state = "queued";
        } catch {}
        emitLifecycle({
          direction: "inbound",
          state,
          channel: "api-send",
          route: resolved.type,
          from: messageFrom,
          to: messageTo,
          target: resolved.target,
          text: message,
          lastLine,
          signed: messageSigned,
        });
        return { ok: true, target: resolved.target, text, source: "local", lastLine, state, ...(inbox?.ok ? { inbox: inbox.path } : {}) };
      }

      // Remote peer → federation HTTP
      if (resolved?.type === "peer") {
        const res = await d.curlFetch(`${resolved.peerUrl}/api/send`, {
          method: "POST",
          body: JSON.stringify({ target: resolved.target, text: message }),
          timeout: 10000,
          from: "auto", // #804 Step 4 SIGN — sign cross-node forwarded /api/send
        });
        if (res.ok && res.data?.ok) {
          const state = res.data.state === "delivered" ? "delivered" : "queued";
          emitLifecycle({
            direction: "forwarded",
            state,
            channel: "api-send",
            route: "peer",
            from: messageFrom,
            to: `${resolved.node}:${resolved.target}`,
            target: res.data.target || resolved.target,
            peerUrl: resolved.peerUrl,
            text: message,
            lastLine: res.data.lastLine || "",
            signed: messageSigned,
          });
          return { ok: true, target: res.data.target || target, text, source: resolved.peerUrl, lastLine: res.data.lastLine || "", state };
        }
        emitLifecycle({
          direction: "forwarded",
          state: "failed",
          channel: "api-send",
          route: "peer",
          from: messageFrom,
          to: `${resolved.node}:${resolved.target}`,
          target: resolved.target,
          peerUrl: resolved.peerUrl,
          text: message,
          error: `${resolved.node} → ${resolved.target} send failed`,
          signed: messageSigned,
        });
        set.status = 502; return { error: `${resolved.node} → ${resolved.target} send failed`, target, source: resolved.peerUrl };
      }

      // Fallback: async peer discovery
      const peerUrl = await d.findPeerForTarget(target, local);
      if (peerUrl) {
        const send = await d.sendKeysToPeerDetailed(peerUrl, target, message);
        emitLifecycle({
          direction: "forwarded",
          state: send.ok ? send.state : "failed",
          channel: "api-send",
          route: "discovery",
          from: messageFrom,
          to: target,
          target: send.target || target,
          peerUrl,
          text: message,
          lastLine: send.lastLine || "",
          error: send.ok ? undefined : (send.error || "Failed to send to peer"),
          signed: messageSigned,
        });
        if (send.ok) {
          return { ok: true, target: send.target || target, text, source: peerUrl, state: send.state, lastLine: send.lastLine || "" };
        }
        set.status = 502; return { error: send.error || "Failed to send to peer", target, source: peerUrl };
      }

      // #835 — consult shouldAutoWake for the "implicit wake on send" decision.
      // Fleet-known target with no local session → wake then retry resolve once.
      // Unknown targets fall through to the existing 404 (no behavior change).
      {
        const isFleetKnown = Boolean(d.resolveFleetSession(target));
        const decision = await d.shouldAutoWake(target, {
          site: "api-send",
          isLive: false,
          isFleetKnown,
        });
        if (decision.wake) {
          try {
            await d.cmdWake(target, { noAttach: true });
            // Retry resolution once, after the wake. If it now resolves locally,
            // recurse the local-send path. This branch is opt-in via fleet
            // membership — unknown targets still 404.
            const refreshed = await d.listSessions();
            const retry = d.resolveTarget(target, config, refreshed);
            if (retry?.type === "local" || retry?.type === "self-node") {
              if (!sessionTargetExists(refreshed, retry.target)) {
                return queueOrFail(retry.target, `target not live in tmux after wake: ${retry.target}`);
              }
              try {
                if (!force) {
                  let idleCheck = await d.checkPaneIdle(retry.target);
                  if (!idleCheck.idle) {
                    await d.sleep(500);
                    idleCheck = await d.checkPaneIdle(retry.target);
                    if (!idleCheck.idle) {
                      const inbox = await writeInboundInbox(retry.target);
                      const queued = inbox ? queuedInboxResponse(inbox, retry.target, "pane not idle after wake") : null;
                      if (queued) return queued;
                      set.status = 409;
                      emitLifecycle({
                        direction: "inbound",
                        state: "failed",
                        channel: "api-send",
                        route: "local",
                        from: messageFrom,
                        to: messageTo,
                        target: retry.target,
                        text: message,
                        error: "pane not idle",
                        lastLine: idleCheck.lastInput,
                        signed: messageSigned,
                      });
                      return { ok: false, error: "pane not idle", target: retry.target, lastInput: idleCheck.lastInput };
                    }
                  }
                }
                await d.sendKeys(retry.target, message);
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return queueOrFail(retry.target, `tmux delivery failed after wake: ${msg}`);
              }
              const inbox = await writeInboundInbox(retry.target);
              await d.sleep(150);
              let lastLine = "";
              try { const content = await d.capture(retry.target, 3); lastLine = content.split("\n").filter(l => l.trim()).pop() || ""; } catch {}
              emitLifecycle({
                direction: "inbound",
                state: "delivered",
                channel: "api-send",
                route: "local",
                from: messageFrom,
                to: messageTo,
                target: retry.target,
                text: message,
                lastLine,
                signed: messageSigned,
              });
              return { ok: true, target: retry.target, text, source: "local", lastLine, wokeFor: target, ...(inbox?.ok ? { inbox: inbox.path } : {}) };
            }
          } catch { /* wake best-effort — fall through to 404 */ }
        }
      }

      const errDetail = resolved?.type === "error" ? { reason: resolved.reason, detail: resolved.detail, hint: resolved.hint } : {};
      const inbox = await writeInboundInbox(target);
      const queued = inbox ? queuedInboxResponse(inbox, target, errDetail.detail || "target not live; persisted for receiver inbox polling") : null;
      if (queued) return queued;
      emitLifecycle({
        direction: "inbound",
        state: "failed",
        channel: "api-send",
        route: "local",
        from: messageFrom,
        to: messageTo,
        target,
        text: message,
        error: errDetail.detail || `target not found: ${target}`,
        signed: messageSigned,
      });
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
  api.post("/pane-keys", async ({ body, set }) => {
    try {
      const { target, text, enter } = body;
      if (!target) { set.status = 400; return { error: "target required" }; }
      const t = d.createTmux();
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
   */
  api.post("/probe", async ({ body, set }) => {
    try {
      const target = body?.target;

      // Bare healthcheck — no target. Just prove we can walk the write path
      // setup (loadConfig + listSessions). If either throws, /send would too.
      if (!target) {
        const config = d.loadConfig();
        const local = await d.listSessions();
        return {
          ok: true,
          transport: "local" as const,
          source: config.node ?? "local",
          sessions: local.length,
        };
      }

      const config = d.loadConfig();
      const local = await d.listSessions();

      // Same resolution as /send — including the -oracle stripped retry — so a
      // probe failure here means /send would fail with the same reason.
      const result = d.resolveTarget(target, config, local);
      const isResolved = result && result.type !== "error";
      const altResult = !isResolved ? d.resolveTarget(target.replace(/-oracle$/, ""), config, local) : null;
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

  api.post("/select", async ({ body, set }) => {
    const { target } = body;
    if (!target) { set.status = 400; return { error: "target required" }; }
    await d.selectWindow(target);
    return { ok: true, target };
  }, {
    body: t.Object({ target: t.String() }),
  });

  api.post("/wake", async ({ body, set }) => {
    try {
      const target = body.target ?? body.oracle;
      if (!target) { set.status = 400; return { error: "target required (or 'oracle' for legacy peers)" }; }
      // #835 — consult unified shouldAutoWake helper. /api/wake's policy is
      // "always wake" (the endpoint exists for that). The helper makes that
      // decision explicit and auditable, mirroring the other 6 sites.
      const decision = await d.shouldAutoWake(target, { site: "api-wake" });
      if (!decision.wake) {
        // Defensive — site=api-wake never returns false today, but keep the
        // branch so future policy changes can't silently no-op the endpoint.
        set.status = 500; return { error: `wake denied: ${decision.reason}` };
      }
      await d.cmdWake(target, { noAttach: true, task: body.task });
      return { ok: true, target };
    } catch (err) {
      set.status = 500; return { error: String(err) };
    }
  }, {
    body: WakeBody,
  });

  api.post("/sleep", async ({ body, set }) => {
    try {
      const { target } = body;
      await d.cmdSleepOne(target);
      return { ok: true, target };
    } catch (err) {
      set.status = 500; return { error: String(err) };
    }
  }, {
    body: SleepBody,
  });

  return api;
}

export const sessionsApi = createSessionsApi();
