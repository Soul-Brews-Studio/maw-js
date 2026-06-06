import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createSessionsApi,
  formatInboxNotification,
  resolveLiveInboxNotificationTarget,
  type SessionsApiDeps,
} from "../src/api/sessions";

function session(name: string, windows: any[]) {
  return { name, windows } as any;
}

function postSend(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://local/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function json(res: Response) {
  return await res.json() as any;
}

function harness(overrides: Partial<SessionsApiDeps> = {}) {
  const calls: any[] = [];
  const sessions = [
    session("50-atlas", [{ index: 0, name: "atlas-oracle", active: true }]),
  ];
  const deps: SessionsApiDeps = {
    listSessions: async () => sessions,
    capture: async () => "",
    sendKeys: async (target: string, text: string) => calls.push(["sendKeys", target, text]),
    selectWindow: async () => undefined,
    checkPaneIdle: async () => ({ idle: true, lastInput: "" }) as any,
    findWindow: (() => null) as any,
    getAggregatedSessions: async (local: any[]) => local,
    findPeerForTarget: async () => null,
    sendKeysToPeer: async () => false,
    sendKeysToPeerDetailed: async () => ({ ok: false, state: "failed" }) as any,
    loadConfig: (() => ({ node: "m5", oracle: "mawjs", sessions: {} })) as any,
    curlFetch: async () => ({ ok: false, status: 0, data: null }) as any,
    resolveTarget: (() => ({ type: "error", reason: "missing", detail: "not live", hint: "wake" })) as any,
    processMirror: ((raw: string) => raw) as any,
    resolveFleetSession: () => null,
    createTmux: () => ({ sendKeysLiteral: async () => undefined, sendKeys: async () => undefined, listPanes: async () => [], capture: async () => "" }) as any,
    emitMessageLifecycle: () => undefined,
    writeReceiverInbox: () => ({
      ok: true,
      oracle: "atlas",
      inboxDir: "/repo/ψ/inbox",
      path: "/repo/ψ/inbox/msg.md",
      filename: "msg.md",
    }),
    sleep: async () => undefined,
    shouldAutoWake: () => ({ wake: false, reason: "policy" }),
    cmdWake: async () => undefined,
    cmdSleepOne: async () => undefined,
    ...overrides,
  };
  return { app: new Elysia().use(createSessionsApi(deps)), calls };
}

describe("/api/send queued inbox live notification (#2057)", () => {
  test("resolves receiver oracle names to live session windows", () => {
    const sessions = [
      session("50-atlas", [{ index: 1, name: "atlas-oracle", active: true }]),
      session("77-mawjs", [{ index: 0, name: "mawjs", active: true }]),
      session("05-volt", [
        { index: 0, name: "volt-oracle", active: false },
        { index: 1, name: "volt-coder-3", active: true },
      ]),
    ];

    expect(resolveLiveInboxNotificationTarget("atlas", sessions)).toBe("50-atlas:atlas-oracle");
    expect(resolveLiveInboxNotificationTarget("mawjs-oracle", sessions)).toBe("77-mawjs:mawjs");
    expect(resolveLiveInboxNotificationTarget("volt", sessions)).toBe("05-volt:volt-oracle");
    expect(resolveLiveInboxNotificationTarget("ghost", sessions)).toBeNull();
  });

  test("injects a notification after queueing inbox when receiver is live", async () => {
    const h = harness();

    const res = await h.app.handle(postSend(
      { target: "atlas", text: "reply body" },
      { "x-maw-from": "mawjs:m5" },
    ));

    expect(await json(res)).toMatchObject({ ok: true, source: "inbox", state: "queued" });
    expect(h.calls).toEqual([[
      "sendKeys",
      "50-atlas:atlas-oracle",
      "📬 maw inbox: new message from m5:mawjs in ψ/inbox/msg.md. Run `maw inbox` to read.",
    ]]);
  });

  test("keeps inbox-only fallback when receiver has no live session", async () => {
    const h = harness({ listSessions: async () => [] });

    expect(await json(await h.app.handle(postSend({ target: "atlas", text: "reply body" })))).toMatchObject({
      ok: true,
      source: "inbox",
      state: "queued",
    });
    expect(h.calls).toEqual([]);
  });

  test("formats concise inbox notification text", () => {
    expect(formatInboxNotification({ ok: true, oracle: "atlas", inboxDir: "/x", path: "/x/msg.md", filename: "msg.md" }, "m5:mawjs"))
      .toBe("📬 maw inbox: new message from m5:mawjs in ψ/inbox/msg.md. Run `maw inbox` to read.");
  });
});
