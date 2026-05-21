import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import {
  createSessionsApi,
  emitMessageLifecycle,
  localMessageIdentity,
  messageSignedRequest,
  requestMessageFrom,
  resolveCapture,
  type SessionsApiDeps,
} from "../src/api/sessions";

function session(name: string, windows = [{ index: 0, name: "main", active: true }]) {
  return { name, windows } as any;
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response) {
  return await res.json() as any;
}

function makeHarness(overrides: SessionsApiDeps = {}) {
  const calls: any[] = [];
  let localSessions = [session("local", [{ index: 0, name: "main", active: true }])];
  const config: any = { node: "m5", oracle: "mawjs", sessions: {} };
  const lifecycle: any[] = [];
  const deps: SessionsApiDeps = {
    listSessions: async () => localSessions as any,
    capture: async (target: string, lines?: number) => {
      calls.push(["capture", target, lines]);
      return "line one\nlast line";
    },
    sendKeys: async (target: string, text: string) => { calls.push(["sendKeys", target, text]); },
    selectWindow: async (target: string) => { calls.push(["selectWindow", target]); },
    checkPaneIdle: async (target: string) => { calls.push(["idle", target]); return { idle: true, lastInput: "" } as any; },
    findWindow: ((sessions: any[], query: string) => `${sessions[0]?.name ?? "missing"}:${query}`) as any,
    getAggregatedSessions: async (local: any[]) => [...local, session("remote", [
      { index: 0, name: "dup", active: false },
      { index: 1, name: "dup", active: true },
    ])] as any,
    findPeerForTarget: async () => null,
    sendKeysToPeer: async (peer: string, target: string, message: string) => { calls.push(["sendKeysToPeer", peer, target, message]); return true; },
    sendKeysToPeerDetailed: async (peer: string, target: string, message: string) => {
      calls.push(["sendKeysToPeerDetailed", peer, target, message]);
      return { ok: true, state: "delivered", target, lastLine: "" } as any;
    },
    loadConfig: (() => config) as any,
    curlFetch: async (url: string, opts: any) => { calls.push(["curlFetch", url, opts]); return { ok: true, status: 200, data: { ok: true } } as any; },
    resolveTarget: (() => ({ type: "error", reason: "missing", detail: "not found", hint: "try wake" })) as any,
    processMirror: ((raw: string, lines: number) => ({ raw, lines, processed: true })) as any,
    resolveFleetSession: () => null,
    createTmux: () => ({
      sendKeysLiteral: async (target: string, text: string) => { calls.push(["literal", target, text]); },
      sendKeys: async (target: string, key: string) => { calls.push(["tmuxKeys", target, key]); },
    } as any),
    emitMessageLifecycle: (input) => { lifecycle.push(input); },
    writeReceiverInbox: null,
    sleep: async (ms: number) => { calls.push(["sleep", ms]); },
    shouldAutoWake: () => ({ wake: false, reason: "policy" }),
    cmdWake: async (target: string, opts: any) => { calls.push(["cmdWake", target, opts]); },
    cmdSleepOne: async (target: string) => { calls.push(["cmdSleepOne", target]); },
    ...overrides,
  };
  const app = new Elysia().use(createSessionsApi(deps));
  return { app, calls, config, lifecycle, deps, setSessions: (s: any[]) => { localSessions = s; } };
}

describe("sessions API helpers", () => {
  test("message identity helpers normalize signed and unsigned senders", () => {
    const config: any = { node: "m5", oracle: "codex" };
    expect(localMessageIdentity(config)).toBe("m5:codex");
    expect(localMessageIdentity({} as any)).toBe("local:mawjs");

    const unsigned = new Request("http://local/send");
    expect(requestMessageFrom(unsigned, config)).toBe("m5:codex");
    expect(messageSignedRequest(unsigned)).toBe(false);

    const signed = new Request("http://local/send", { headers: { "x-maw-from": "oracle:white" } });
    expect(requestMessageFrom(signed, config)).toBe("white:oracle");
    expect(messageSignedRequest(signed)).toBe(true);

    const malformed = new Request("http://local/send", { headers: { "x-maw-from": "wire-formatless" } });
    expect(requestMessageFrom(malformed, config)).toBe("wire-formatless");
  });

  test("emitMessageLifecycle pushes built feed events and swallows hook failures", () => {
    const pushed: any[] = [];
    emitMessageLifecycle({ direction: "inbound", state: "delivered", channel: "api-send", route: "local", from: "a", to: "b", target: "t", text: "hi" }, {
      buildMessageLifecycleFeedEvent: ((input: any) => ({ built: input.text })) as any,
      pushFeedEvent: ((event: any) => pushed.push(event)) as any,
    });
    expect(pushed).toEqual([{ built: "hi" }]);

    expect(() => emitMessageLifecycle({ direction: "inbound", state: "failed", channel: "api-send", route: "local", from: "a", to: "b", target: "t", text: "hi" }, {
      buildMessageLifecycleFeedEvent: (() => { throw new Error("boom"); }) as any,
      pushFeedEvent: (() => { throw new Error("boom"); }) as any,
    })).not.toThrow();
  });

  test("resolveCapture uses mapped sessions, fleet sessions, and fallback window lookup", () => {
    expect(resolveCapture("neo", [session("mapped")], {
      loadConfig: (() => ({ sessions: { neo: "mapped" } })) as any,
      findWindow: (() => "mapped:neo") as any,
      resolveFleetSession: () => null,
    })).toBe("mapped:neo");

    expect(resolveCapture("tile", [session("fleet")], {
      loadConfig: (() => ({ sessions: {} })) as any,
      findWindow: (() => null) as any,
      resolveFleetSession: () => "fleet",
    })).toBe("tile");

    expect(resolveCapture("plain", [session("local")], {
      loadConfig: (() => ({ sessions: {} })) as any,
      findWindow: (() => "local:plain") as any,
      resolveFleetSession: () => null,
    })).toBe("local:plain");
  });
});

describe("sessions, capture, and mirror routes", () => {
  test("GET /sessions returns local or aggregated sessions with deduped windows", async () => {
    const h = makeHarness();
    h.setSessions([session("local", [
      { index: 0, name: "dup", active: false },
      { index: 1, name: "dup", active: true },
    ])]);

    const local = await readJson(await h.app.handle(new Request("http://local/sessions?local=true")));
    expect(local).toEqual([{ name: "local", source: "local", windows: [{ index: 1, name: "dup", active: true }] }]);

    const aggregated = await readJson(await h.app.handle(new Request("http://local/sessions")));
    expect(aggregated.map((s: any) => [s.name, s.windows.length])).toEqual([["local", 1], ["remote", 1]]);
  });

  test("GET /sessions surfaces tmux availability errors instead of silently returning []", async () => {
    const h = makeHarness({
      listSessions: async () => { throw new Error("[local:local] bash: tmux: command not found"); },
    });

    const res = await h.app.handle(new Request("http://local/sessions?local=true"));
    expect(res.status).toBe(503);
    const body = await readJson(res);
    expect(body.error).toContain("tmux unavailable");
    expect(body.error).toContain("tmux: command not found");
    expect(body.hint).toContain("/opt/homebrew/bin");
    expect(body.hint).toContain("pm2 restart maw --update-env");
  });

  test("GET /capture validates target, resolves aliases, and reports capture errors", async () => {
    const h = makeHarness();
    h.config.sessions.neo = "local";

    const missing = await h.app.handle(new Request("http://local/capture"));
    expect(missing.status).toBe(400);

    const ok = await readJson(await h.app.handle(new Request("http://local/capture?target=neo")));
    expect(ok).toEqual({ content: "line one\nlast line" });
    expect(h.calls[0]).toEqual(["capture", "local:neo", undefined]);

    const err = makeHarness({ capture: async () => { throw new Error("capture boom"); } });
    expect(await readJson(await err.app.handle(new Request("http://local/capture?target=neo")))).toEqual({ content: "", error: "capture boom" });
  });

  test("GET /mirror validates target and processes captured output", async () => {
    const h = makeHarness();
    const missing = await h.app.handle(new Request("http://local/mirror"));
    expect(missing.status).toBe(400);
    expect(await missing.text()).toBe("target required");

    const ok = await readJson(await h.app.handle(new Request("http://local/mirror?target=neo&lines=7")));
    expect(ok).toEqual({ raw: "line one\nlast line", lines: 7, processed: true });
  });
});

describe("POST /send", () => {
  test("rejects local sends when pane remains busy and records signed attachment lifecycle", async () => {
    const idleChecks = [{ idle: false, lastInput: "draft" }, { idle: false, lastInput: "still typing" }] as any[];
    const h = makeHarness({
      checkPaneIdle: async () => idleChecks.shift() as any,
      resolveTarget: (() => ({ type: "local", target: "local:main" })) as any,
    });

    const res = await h.app.handle(jsonRequest("/send", { target: "neo", text: "hello", attachments: ["a", "b"] }, { "x-maw-from": "sender:white" }));

    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ ok: false, error: "pane not idle", lastInput: "still typing" });
    expect(h.lifecycle[0]).toMatchObject({ state: "failed", from: "white:sender", signed: true, text: "a\nb\nhello" });
  });

  test("delivers local sends, detects queued prompts, and supports stripped -oracle fallback", async () => {
    let first = true;
    const h = makeHarness({
      resolveTarget: ((target: string) => {
        if (first) { first = false; return { type: "error", reason: "miss" }; }
        return { type: "self-node", target: `${target}:main` };
      }) as any,
      listSessions: async () => [session("neo", [{ index: 0, name: "main", active: true }])] as any,
      capture: async () => "body\nPress up to edit queued messages\nqueued line",
    });

    const res = await h.app.handle(jsonRequest("/send", { target: "neo-oracle", text: "hello" }));

    expect(await readJson(res)).toMatchObject({ ok: true, target: "neo:main", source: "local", state: "queued", lastLine: "queued line" });
    expect(h.calls).toContainEqual(["sendKeys", "neo:main", "hello"]);
    expect(h.lifecycle[0]).toMatchObject({ state: "queued", signed: false });
  });

  test("mirrors inbound local /send deliveries to receiver inbox when enabled", async () => {
    const inboxCalls: any[] = [];
    const h = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "54-digger:digger-oracle.0" })) as any,
      listSessions: async () => [session("54-digger", [{ index: 0, name: "digger-oracle", active: true }])] as any,
      writeReceiverInbox: (input) => {
        inboxCalls.push(input);
        return {
          ok: true,
          oracle: "digger",
          inboxDir: "/repo/ψ/inbox",
          path: "/repo/ψ/inbox/msg.md",
          filename: "msg.md",
        };
      },
    });

    const res = await readJson(await h.app.handle(jsonRequest("/send", { target: "digger", text: "dig please" }, { "x-maw-from": "homekeeper:m5" })));

    expect(res).toMatchObject({ ok: true, target: "54-digger:digger-oracle.0", source: "local", inbox: "/repo/ψ/inbox/msg.md" });
    expect(inboxCalls).toEqual([{
      query: "digger",
      target: "54-digger:digger-oracle.0",
      to: "digger",
      from: "m5:homekeeper",
      message: "dig please",
      config: h.config,
    }]);
  });

  test("force skips idle guard and capture failures are delivery-safe", async () => {
    const h = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "local:main" })) as any,
      capture: async () => { throw new Error("capture ignored"); },
    });

    const res = await h.app.handle(jsonRequest("/send", { target: "neo", text: "hello", force: true }));

    expect(await readJson(res)).toMatchObject({ ok: true, lastLine: "", state: "delivered" });
    expect(h.calls.some((c) => c[0] === "idle")).toBe(false);
  });

  test("waits once when a local pane is briefly busy then delivers", async () => {
    const idleChecks = [{ idle: false, lastInput: "typing" }, { idle: true, lastInput: "" }] as any[];
    const h = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "local:main" })) as any,
      checkPaneIdle: async (target: string) => { h.calls.push(["idle", target]); return idleChecks.shift() as any; },
    });

    expect(await readJson(await h.app.handle(jsonRequest("/send", { target: "neo", text: "hello" })))).toMatchObject({ ok: true, target: "local:main" });
    expect(h.calls).toContainEqual(["sleep", 500]);
    expect(h.calls).toContainEqual(["sendKeys", "local:main", "hello"]);
  });

  test("forwards peer sends and reports peer failures", async () => {
    const success = makeHarness({
      resolveTarget: (() => ({ type: "peer", node: "white", peerUrl: "http://peer", target: "remote:main" })) as any,
      curlFetch: async () => ({ ok: true, status: 200, data: { ok: true, target: "actual", state: "queued", lastLine: "queued" } }) as any,
    });
    expect(await readJson(await success.app.handle(jsonRequest("/send", { target: "remote", text: "hi" })))).toMatchObject({ ok: true, source: "http://peer", target: "actual", state: "queued" });
    expect(success.lifecycle[0]).toMatchObject({ route: "peer", state: "queued", to: "white:remote:main" });

    const acceptedOnly = makeHarness({
      resolveTarget: (() => ({ type: "peer", node: "white", peerUrl: "http://peer", target: "remote:main" })) as any,
      curlFetch: async () => ({ ok: true, status: 200, data: { ok: true, target: "actual" } }) as any,
    });
    expect(await readJson(await acceptedOnly.app.handle(jsonRequest("/send", { target: "remote", text: "hi" })))).toMatchObject({ state: "queued" });
    expect(acceptedOnly.lifecycle[0]).toMatchObject({ route: "peer", state: "queued" });

    const failure = makeHarness({
      resolveTarget: (() => ({ type: "peer", node: "white", peerUrl: "http://peer", target: "remote:main" })) as any,
      curlFetch: async () => ({ ok: false, status: 500, data: { ok: false } }) as any,
    });
    const res = await failure.app.handle(jsonRequest("/send", { target: "remote", text: "hi" }));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "white → remote:main send failed", target: "remote", source: "http://peer" });
    expect(failure.lifecycle[0]).toMatchObject({ route: "peer", state: "failed" });
  });

  test("falls back to peer discovery and preserves receiver delivery state", async () => {
    const ok = makeHarness({
      findPeerForTarget: async () => "http://found",
      sendKeysToPeerDetailed: async () => ({ ok: true, state: "delivered", target: "remote:main", lastLine: "landed" }) as any,
    });
    expect(await readJson(await ok.app.handle(jsonRequest("/send", { target: "remote", text: "hi" })))).toMatchObject({
      ok: true,
      source: "http://found",
      target: "remote:main",
      state: "delivered",
      lastLine: "landed",
    });

    const queued = makeHarness({
      findPeerForTarget: async () => "http://found",
      sendKeysToPeerDetailed: async () => ({ ok: true, state: "queued", target: "remote", lastLine: "" }) as any,
    });
    expect(await readJson(await queued.app.handle(jsonRequest("/send", { target: "remote", text: "hi" })))).toMatchObject({
      ok: true,
      source: "http://found",
      state: "queued",
    });
    expect(queued.lifecycle[0]).toMatchObject({ route: "discovery", state: "queued" });

    const fail = makeHarness({
      findPeerForTarget: async () => "http://found",
      sendKeysToPeerDetailed: async () => ({ ok: false, state: "failed", target: "remote", error: "receiver rejected delivery" }) as any,
    });
    const res = await fail.app.handle(jsonRequest("/send", { target: "remote", text: "hi" }));
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "receiver rejected delivery", target: "remote", source: "http://found" });
    expect(fail.lifecycle[0]).toMatchObject({ route: "discovery", state: "failed", error: "receiver rejected delivery" });
  });

  test("auto-wakes fleet-known targets, retries local resolution, and handles retry busy failure", async () => {
    let resolveCalls = 0;
    const ok = makeHarness({
      resolveFleetSession: () => "54-neo",
      shouldAutoWake: () => ({ wake: true }),
      resolveTarget: (() => (++resolveCalls <= 2 ? { type: "error", reason: "missing" } : { type: "local", target: "54-neo:main" })) as any,
      listSessions: async () => [session("54-neo", [{ index: 0, name: "main", active: true }])] as any,
      capture: async () => "after wake\nready",
    });
    expect(await readJson(await ok.app.handle(jsonRequest("/send", { target: "neo", text: "wake hi" })))).toMatchObject({ ok: true, target: "54-neo:main", wokeFor: "neo" });
    expect(ok.calls).toContainEqual(["cmdWake", "neo", { noAttach: true }]);

    let busyResolveCalls = 0;
    const busy = makeHarness({
      resolveFleetSession: () => "54-neo",
      shouldAutoWake: () => ({ wake: true }),
      resolveTarget: (() => (++busyResolveCalls <= 2 ? { type: "error", reason: "missing" } : { type: "local", target: "54-neo:main" })) as any,
      listSessions: async () => [session("54-neo", [{ index: 0, name: "main", active: true }])] as any,
      checkPaneIdle: async () => ({ idle: false, lastInput: "busy" }) as any,
    });
    const res = await busy.app.handle(jsonRequest("/send", { target: "neo", text: "wake hi" }));
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ ok: false, error: "pane not idle", target: "54-neo:main" });

    let transientResolveCalls = 0;
    const transientIdle = [{ idle: false, lastInput: "typing" }, { idle: true, lastInput: "" }] as any[];
    const transient = makeHarness({
      resolveFleetSession: () => "54-neo",
      shouldAutoWake: () => ({ wake: true }),
      resolveTarget: (() => (++transientResolveCalls <= 2 ? { type: "error", reason: "missing" } : { type: "local", target: "54-neo:main" })) as any,
      listSessions: async () => [session("54-neo", [{ index: 0, name: "main", active: true }])] as any,
      checkPaneIdle: async (target: string) => { transient.calls.push(["idle", target]); return transientIdle.shift() as any; },
      capture: async () => "after wake\nready",
    });
    expect(await readJson(await transient.app.handle(jsonRequest("/send", { target: "neo", text: "wake hi" })))).toMatchObject({ ok: true, target: "54-neo:main", wokeFor: "neo" });
    expect(transient.calls).toContainEqual(["sleep", 500]);
  });

  test("falls through after wake errors and returns detailed 404s", async () => {
    const wakeBoom = makeHarness({
      resolveFleetSession: () => "54-neo",
      shouldAutoWake: () => ({ wake: true }),
      cmdWake: async () => { throw new Error("wake boom"); },
      resolveTarget: (() => ({ type: "error", reason: "missing", detail: "no target", hint: "try wake" })) as any,
    });
    const notFound = await wakeBoom.app.handle(jsonRequest("/send", { target: "neo", text: "hi" }));
    expect(notFound.status).toBe(404);
    expect(await readJson(notFound)).toMatchObject({ error: "target not found: neo", reason: "missing", detail: "no target", hint: "try wake" });
    expect(wakeBoom.lifecycle[0]).toMatchObject({ state: "failed", error: "no target" });

    const outer = makeHarness({ listSessions: async () => { throw new Error("list boom"); } });
    const res = await outer.app.handle(jsonRequest("/send", { target: "neo", text: "hi" }));
    expect(res.status).toBe(404);
    expect(await readJson(res)).toMatchObject({ error: "target not found: neo" });
  });

  test("fails local sends when tmux proof fails and no receiver inbox is available", async () => {
    const missingTarget = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "54-ghost:ghost-oracle" })) as any,
      listSessions: async () => [session("other", [{ index: 0, name: "main", active: true }])] as any,
    });
    const missingRes = await missingTarget.app.handle(jsonRequest("/send", { target: "ghost", text: "hi" }));
    expect(missingRes.status).toBe(502);
    expect(await readJson(missingRes)).toEqual({ ok: false, error: "target not live in tmux: 54-ghost:ghost-oracle", target: "54-ghost:ghost-oracle" });
    expect(missingTarget.lifecycle[0]).toMatchObject({ state: "failed", error: "target not live in tmux: 54-ghost:ghost-oracle" });

    const initialListFails = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "54-ghost:ghost-oracle" })) as any,
      listSessions: async () => { throw new Error("tmux offline"); },
    });
    const offlineRes = await initialListFails.app.handle(jsonRequest("/send", { target: "ghost", text: "hi" }));
    expect(offlineRes.status).toBe(502);
    expect(await readJson(offlineRes)).toMatchObject({ ok: false, error: "tmux unavailable: tmux offline" });

    let calls = 0;
    const freshListFails = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "54-ghost:ghost-oracle" })) as any,
      listSessions: async () => {
        calls += 1;
        if (calls === 1) return [session("54-ghost", [{ index: 0, name: "ghost-oracle", active: true }])] as any;
        throw new Error("fresh tmux offline");
      },
    });
    const freshRes = await freshListFails.app.handle(jsonRequest("/send", { target: "ghost", text: "hi" }));
    expect(freshRes.status).toBe(502);
    expect(await readJson(freshRes)).toMatchObject({ ok: false, error: "tmux unavailable: fresh tmux offline" });
  });

  test("auto-wake retry failures do not claim delivery without inbox fallback", async () => {
    let missingResolveCalls = 0;
    const missingAfterWake = makeHarness({
      resolveFleetSession: () => "54-neo",
      shouldAutoWake: () => ({ wake: true }),
      resolveTarget: (() => (++missingResolveCalls <= 2 ? { type: "error", reason: "missing" } : { type: "local", target: "54-neo:main" })) as any,
      listSessions: async () => [session("other", [{ index: 0, name: "main", active: true }])] as any,
    });
    const missingRes = await missingAfterWake.app.handle(jsonRequest("/send", { target: "neo", text: "wake hi" }));
    expect(missingRes.status).toBe(502);
    expect(await readJson(missingRes)).toMatchObject({ ok: false, error: "target not live in tmux after wake: 54-neo:main" });

    let failResolveCalls = 0;
    const sendFailsAfterWake = makeHarness({
      resolveFleetSession: () => "54-neo",
      shouldAutoWake: () => ({ wake: true }),
      resolveTarget: (() => (++failResolveCalls <= 2 ? { type: "error", reason: "missing" } : { type: "local", target: "54-neo:main" })) as any,
      listSessions: async () => [session("54-neo", [{ index: 0, name: "main", active: true }])] as any,
      sendKeys: async () => { throw new Error("pane vanished"); },
    });
    const sendFailRes = await sendFailsAfterWake.app.handle(jsonRequest("/send", { target: "neo", text: "wake hi" }));
    expect(sendFailRes.status).toBe(502);
    expect(await readJson(sendFailRes)).toMatchObject({ ok: false, error: "tmux delivery failed after wake: pane vanished" });
  });

  test("unexpected send errors return a 500 instead of leaking exceptions", async () => {
    const h = makeHarness({ resolveTarget: (() => { throw new Error("resolver exploded"); }) as any });
    const res = await h.app.handle(jsonRequest("/send", { target: "neo", text: "hi" }));
    expect(res.status).toBe(500);
    expect((await readJson(res)).error).toContain("resolver exploded");
  });

  test("queues instead of claiming delivered when tmux delivery cannot be proven", async () => {
    const missingTarget = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "54-ghost:ghost-oracle" })) as any,
      listSessions: async () => [session("other", [{ index: 0, name: "main", active: true }])] as any,
      writeReceiverInbox: () => ({
        ok: true,
        oracle: "ghost",
        inboxDir: "/repo/ψ/inbox",
        path: "/repo/ψ/inbox/ghost.md",
        filename: "ghost.md",
      }),
    });
    expect(await readJson(await missingTarget.app.handle(jsonRequest("/send", { target: "ghost", text: "hi" })))).toMatchObject({
      ok: true,
      source: "inbox",
      state: "queued",
      reason: "target not live in tmux: 54-ghost:ghost-oracle",
    });
    expect(missingTarget.calls.some(c => c[0] === "sendKeys")).toBe(false);

    const sendFails = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "54-ghost:ghost-oracle" })) as any,
      listSessions: async () => [session("54-ghost", [{ index: 0, name: "ghost-oracle", active: true }])] as any,
      sendKeys: async () => { throw new Error("can't find pane"); },
      writeReceiverInbox: () => ({
        ok: true,
        oracle: "ghost",
        inboxDir: "/repo/ψ/inbox",
        path: "/repo/ψ/inbox/send-fail.md",
        filename: "send-fail.md",
      }),
    });
    expect(await readJson(await sendFails.app.handle(jsonRequest("/send", { target: "ghost", text: "hi" })))).toMatchObject({
      ok: true,
      source: "inbox",
      state: "queued",
      reason: "tmux delivery failed: can't find pane",
    });
  });

  test("queues inbound /send to receiver inbox when target is offline", async () => {
    const h = makeHarness({
      resolveTarget: (() => ({ type: "error", reason: "missing", detail: "not live", hint: "wake" })) as any,
      writeReceiverInbox: () => ({
        ok: true,
        oracle: "digger",
        inboxDir: "/repo/ψ/inbox",
        path: "/repo/ψ/inbox/offline.md",
        filename: "offline.md",
      }),
    });

    const res = await h.app.handle(jsonRequest("/send", { target: "digger", text: "offline task" }, { "x-maw-from": "homekeeper:m5" }));

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      ok: true,
      target: "digger",
      text: "offline task",
      source: "inbox",
      state: "queued",
      inbox: "/repo/ψ/inbox/offline.md",
      reason: "not live",
    });
    expect(h.lifecycle[0]).toMatchObject({
      route: "inbox",
      state: "queued",
      from: "m5:homekeeper",
      to: "m5:digger",
      target: "digger",
    });
  });
});

describe("pane keys, probe, select, wake, and sleep routes", () => {
  test("POST /pane-keys validates target, sends literal text, enter, and reports tmux errors", async () => {
    const h = makeHarness();
    expect((await h.app.handle(jsonRequest("/pane-keys", { target: "", text: "x" }))).status).toBe(400);

    expect(await readJson(await h.app.handle(jsonRequest("/pane-keys", { target: "pane", text: "hello", enter: true })))).toEqual({ ok: true, target: "pane", enter: true });
    expect(h.calls).toContainEqual(["literal", "pane", "hello"]);
    expect(h.calls).toContainEqual(["tmuxKeys", "pane", "Enter"]);

    const noText = makeHarness();
    expect(await readJson(await noText.app.handle(jsonRequest("/pane-keys", { target: "pane", text: "", enter: false })))).toEqual({ ok: true, target: "pane", enter: false });
    expect(noText.calls).toEqual([]);

    const boom = makeHarness({ createTmux: () => ({ sendKeysLiteral: async () => { throw new Error("tmux boom"); }, sendKeys: async () => {} }) as any });
    const res = await boom.app.handle(jsonRequest("/pane-keys", { target: "pane", text: "x" }));
    expect(res.status).toBe(500);
    expect((await readJson(res)).error).toContain("tmux boom");
  });

  test("default dependency factories stay side-effect-safe on no-op routes", async () => {
    const paneApp = new Elysia().use(createSessionsApi({}));
    expect(await readJson(await paneApp.handle(jsonRequest("/pane-keys", { target: "pane", text: "", enter: false })))).toEqual({ ok: true, target: "pane", enter: false });

    const h = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "local:main" })) as any,
      capture: async () => "ready",
    });
    const { sleep: _sleep, ...depsWithoutSleep } = h.deps as any;
    const sleepApp = new Elysia().use(createSessionsApi(depsWithoutSleep));
    expect(await readJson(await sleepApp.handle(jsonRequest("/send", { target: "neo", text: "hello", force: true })))).toMatchObject({ ok: true, target: "local:main" });

    const builtEvents: any[] = [];
    const lifecycleHarness = makeHarness({
      resolveTarget: (() => ({ type: "local", target: "local:main" })) as any,
      capture: async () => "ready",
      buildMessageLifecycleFeedEvent: ((input: any) => ({ state: input.state, target: input.target })) as any,
      pushFeedEvent: ((event: any) => builtEvents.push(event)) as any,
    });
    const { emitMessageLifecycle: _emit, ...depsWithoutLifecycleOverride } = lifecycleHarness.deps as any;
    const lifecycleApp = new Elysia().use(createSessionsApi(depsWithoutLifecycleOverride));
    expect(await readJson(await lifecycleApp.handle(jsonRequest("/send", { target: "neo", text: "hello", force: true })))).toMatchObject({ ok: true, target: "local:main" });
    expect(builtEvents).toContainEqual({ state: "delivered", target: "local:main" });
  });

  test("POST /probe covers bare, local, missing-session, peer, not-found, and catch branches", async () => {
    const bare = makeHarness();
    expect(await readJson(await bare.app.handle(jsonRequest("/probe", {})))).toEqual({ ok: true, transport: "local", source: "m5", sessions: 1 });

    const local = makeHarness({ resolveTarget: (() => ({ type: "local", target: "local:main" })) as any });
    expect(await readJson(await local.app.handle(jsonRequest("/probe", { target: "neo" })))).toMatchObject({ ok: true, target: "local:main", transport: "local" });

    const missing = makeHarness({ resolveTarget: (() => ({ type: "local", target: "gone:main" })) as any });
    const missingRes = await missing.app.handle(jsonRequest("/probe", { target: "neo" }));
    expect(missingRes.status).toBe(404);
    expect(await readJson(missingRes)).toMatchObject({ ok: false, error: "tmux session not found: gone" });

    const peer = makeHarness({ resolveTarget: (() => ({ type: "peer", target: "remote:main", peerUrl: "http://peer", node: "white" })) as any });
    expect(await readJson(await peer.app.handle(jsonRequest("/probe", { target: "remote" })))).toEqual({ ok: true, target: "remote:main", transport: "ssh", source: "http://peer", node: "white" });

    const notFound = makeHarness({ resolveTarget: (() => ({ type: "error", reason: "missing", detail: "no", hint: "wake" })) as any });
    const nf = await notFound.app.handle(jsonRequest("/probe", { target: "ghost" }));
    expect(nf.status).toBe(404);
    expect(await readJson(nf)).toMatchObject({ ok: false, error: "target not found: ghost", reason: "missing", detail: "no", hint: "wake" });

    const catchHarness = makeHarness({ loadConfig: (() => { throw new Error("config boom"); }) as any });
    const err = await catchHarness.app.handle(jsonRequest("/probe", { target: "ghost" }));
    expect(err.status).toBe(500);
    expect((await readJson(err)).error).toContain("config boom");
  });

  test("POST /select selects windows and validates empty targets", async () => {
    const h = makeHarness();
    expect((await h.app.handle(jsonRequest("/select", { target: "" }))).status).toBe(400);
    expect(await readJson(await h.app.handle(jsonRequest("/select", { target: "local:main" })))).toEqual({ ok: true, target: "local:main" });
    expect(h.calls).toContainEqual(["selectWindow", "local:main"]);
  });

  test("POST /wake covers missing target, denied, legacy oracle, success, and catch", async () => {
    const missing = makeHarness();
    expect((await missing.app.handle(jsonRequest("/wake", {}))).status).toBe(400);

    const denied = makeHarness({ shouldAutoWake: () => ({ wake: false, reason: "blocked" }) });
    const deniedRes = await denied.app.handle(jsonRequest("/wake", { target: "neo" }));
    expect(deniedRes.status).toBe(500);
    expect(await readJson(deniedRes)).toEqual({ error: "wake denied: blocked" });

    const legacy = makeHarness({ shouldAutoWake: () => ({ wake: true }) });
    expect(await readJson(await legacy.app.handle(jsonRequest("/wake", { oracle: "old", task: "fix" })))).toEqual({ ok: true, target: "old" });
    expect(legacy.calls).toContainEqual(["cmdWake", "old", { noAttach: true, task: "fix" }]);

    const boom = makeHarness({ shouldAutoWake: () => ({ wake: true }), cmdWake: async () => { throw new Error("wake failed"); } });
    const res = await boom.app.handle(jsonRequest("/wake", { target: "neo" }));
    expect(res.status).toBe(500);
    expect((await readJson(res)).error).toContain("wake failed");
  });

  test("POST /sleep runs sleep command and reports errors", async () => {
    const h = makeHarness();
    expect(await readJson(await h.app.handle(jsonRequest("/sleep", { target: "neo" })))).toEqual({ ok: true, target: "neo" });
    expect(h.calls).toContainEqual(["cmdSleepOne", "neo"]);

    const boom = makeHarness({ cmdSleepOne: async () => { throw new Error("sleep boom"); } });
    const res = await boom.app.handle(jsonRequest("/sleep", { target: "neo" }));
    expect(res.status).toBe(500);
    expect((await readJson(res)).error).toContain("sleep boom");
  });
});
