/**
 * kobo-431 — company-scope gate on POST /api/send, local/self-node delivery.
 *
 * Zero prior test coverage existed for this route (checked before writing).
 * This proves the AC literally: for a refused cross-company send, the mocked
 * `sendKeys` (the actual pane-injection call) is NEVER invoked — not that a
 * warning was logged while delivery proceeded, which is the failure shape
 * this whole card exists to eliminate.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSessionsApi } from "./sessions";
import { COMPANIES_DIR, _setCompaniesDir, saveCompany, type Company } from "../vendor/mpr-plugins/company/company-helpers";
import { _clearScopeCache } from "../core/worklog/company-scope";
import type { Session } from "../core/runtime/find-window";

const ORIGINAL_COMPANIES_DIR = COMPANIES_DIR;
const ORIGINAL_STATE_DIR = process.env.MAW_STATE_DIR;
const ORIGINAL_FETCH = globalThis.fetch;
let companiesTmp: string;
let stateTmp: string;

const pgw = (): Company => ({
  name: "pgw",
  manager: "thawanban",
  teams: { core: { lead: "nai", members: [{ oracle: "nai", role: "lead" }, { oracle: "lek", role: "dev" }] } },
});
const kobo = (): Company => ({
  name: "kobo",
  manager: "eq3",
  teams: { dev: { lead: "patchwork", members: [{ oracle: "patchwork", role: "dev" }] } },
});

beforeEach(() => {
  companiesTmp = mkdtempSync(join(tmpdir(), "kobo431-companies-"));
  _setCompaniesDir(companiesTmp);
  _clearScopeCache();
  saveCompany(pgw());
  saveCompany(kobo());
  stateTmp = mkdtempSync(join(tmpdir(), "kobo431-state-"));
  process.env.MAW_STATE_DIR = stateTmp; // isolates trust.json from the real one
  // checkBusyGuard (agent-status-guard.ts) falls through to a real fetch to
  // localhost:3456 when agentStatusStore has no entry for the target — which
  // is every target here, since nothing in this file reports status. On a
  // box where that port isn't answering, that's a multi-second hang per test
  // (kobo-431/449). Stub only the TRANSPORT, same pattern as the established
  // test/isolated/agent-status-guard.test.ts: checkBusyGuard's own decision
  // logic still runs for real (store-miss → fetch fails fast → not busy),
  // so this cannot mask a broken busy-guard decision, only the network wait.
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
});
afterEach(() => {
  _setCompaniesDir(ORIGINAL_COMPANIES_DIR);
  _clearScopeCache();
  try { rmSync(companiesTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (ORIGINAL_STATE_DIR === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = ORIGINAL_STATE_DIR;
  try { rmSync(stateTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  globalThis.fetch = ORIGINAL_FETCH;
});

// Sessions named `<oracle>-oracle` matching the real fleet convention —
// targetOracle() strips the `-oracle` suffix, so the mocked resolveTarget's
// returned pane address must follow the same shape production code produces,
// or the gate resolves the wrong oracle name (caught by running this, not
// assumed: an earlier draft used a fixture name that collided with the
// suffix-stripping rule and silently resolved to the wrong oracle).
const sessions: Session[] = [
  { name: "nai-oracle", windows: [{ index: 0, name: "nai-oracle", active: true }] },
  { name: "lek-oracle", windows: [{ index: 0, name: "lek-oracle", active: true }] },
];

function makeApi(overrides: { resolveTarget: (q: string) => any }) {
  const sendKeys = mock(async () => {});
  const api = createSessionsApi({
    listSessions: async () => sessions,
    loadConfig: () => ({ node: "m5", agents: {} }) as any,
    resolveTarget: overrides.resolveTarget as any,
    sendKeys: sendKeys as any,
    emitMessageLifecycle: () => {}, // no-op — not under test here
    writeReceiverInbox: null, // not under test here; disable the side channel
  });
  return { api, sendKeys };
}

async function postSend(api: ReturnType<typeof createSessionsApi>, from: string, target: string, text: string) {
  return api.handle(
    new Request("http://localhost/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-maw-from": from },
      body: JSON.stringify({ target, text }),
    }),
  );
}

describe("POST /api/send — company-scope gate on local/self-node delivery (kobo-431)", () => {
  it("refuses cross-company: sendKeys is NEVER called, not just warned-and-sent", async () => {
    const { api, sendKeys } = makeApi({
      resolveTarget: () => ({ type: "local", target: "nai-oracle:0" }),
    });
    // sender "patchwork" (kobo) → target resolves to a pgw member ("nai") — cross-company
    const res = await postSend(api, "patchwork:m5", "nai", "hello");
    const body = await res.json();

    expect(sendKeys).not.toHaveBeenCalled(); // the actual AC: did not arrive
    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("cross-company dispatch is blocked");
  });

  it("still delivers same-company sends — no regression on the hot path everyone uses", async () => {
    const { api, sendKeys } = makeApi({
      resolveTarget: () => ({ type: "local", target: "lek-oracle:0" }),
    });
    // sender "nai" (pgw) → target "lek" (also pgw) — same company
    const res = await postSend(api, "nai:m5", "lek", "hello");
    await res.json();

    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("Defect B — a node:agent resolving to local/self-node is scope-gated too, whatever produced that result", async () => {
    // Simulates resolveTarget returning "local" for a node:agent query —
    // whether that came from a declared `hostAliases` self-match (kobo-431
    // Option C) or an ordinary local hit, the company-scope gate below must
    // apply either way. We assert the OUTCOME (a "local" result reaching our
    // gate), since how resolveTarget got there is routing.ts's own tested logic.
    const { api, sendKeys } = makeApi({
      resolveTarget: () => ({ type: "local", target: "nai-oracle:0" }), // post-fallback shape
    });
    const res = await postSend(api, "patchwork:m5", "othernode:nai", "hello"); // "nai" is a pgw member, patchwork is kobo
    const body = await res.json();

    expect(sendKeys).not.toHaveBeenCalled();
    expect(body.error).toContain("cross-company dispatch is blocked");
  });

  it("Defect B FIXED — a same-company bare-name guess no longer silently 'succeeds' (kobo-431 Option C)", async () => {
    // This is the exact scenario that used to be CONFIRMED OPEN (git blame this
    // line): the scope gate alone answers "different company?" not "elsewhere?",
    // and the deleted resolveLocalFallbackForUnknownNode guessed that an unknown
    // node "othernode" meant nothing in particular and injected the live bare-name
    // match anyway — even same-company. That guessing fallback is gone. With no
    // `hostAliases` entry declaring "othernode" as this host, an unknown node now
    // stays an error at the routing layer and never reaches sendKeys at all. This
    // flip (was: sendKeys called + 200 + ok, now: refused) IS the fix's proof.
    const sendKeys = mock(async () => {});
    const api = createSessionsApi({
      listSessions: async () => sessions,
      loadConfig: () => ({ node: "m5", agents: {} }) as any,
      sendKeys: sendKeys as any,
      emitMessageLifecycle: () => {},
      writeReceiverInbox: null,
      resolveTarget: ((q: string) => {
        if (q === "othernode:lek") return { type: "error", reason: "unknown_node", detail: "node 'othernode' not in namedPeers, peers, or hostAliases" };
        if (q === "lek") return { type: "local", target: "lek-oracle:0" };
        return { type: "error", reason: "not_found", detail: `'${q}' not found` };
      }) as any,
    });
    const res = await postSend(api, "nai:m5", "othernode:lek", "hello");
    const body = await res.json();

    expect(sendKeys).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(body.ok).toBeUndefined();
  });

  it("a pre-declared trust pair bypasses the gate — explicit intent, not a caller-settable flag", async () => {
    const { cmdAdd } = await import("../lib/trust-store");
    // Requires a SEPARATE, prior `maw trust add` — not settable inline on this
    // send itself (kobo-431 unhappy path 2 / TRAP 2: distinct from an env var
    // or a flag the sender could set on their own request).
    cmdAdd("patchwork", "nai");

    const { api, sendKeys } = makeApi({
      resolveTarget: () => ({ type: "local", target: "nai-oracle:0" }),
    });
    const res = await postSend(api, "patchwork:m5", "nai", "hello");
    await res.json();

    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

// kobo-474 — the sessions.ts twin (api/sessions.ts:89-99, localMessageIdentity/
// requestMessageFrom falling to config.oracle when x-maw-from is absent)
// shares the SAME poison comm-send.ts's aclSenderOracle had, but is
// DELIBERATELY NOT TOUCHED in this card. %5's review (kobo-474 c7) found
// that a fail-loud-on-missing-header change here breaks 5 pre-existing
// tests representing REAL, already-live callers that send local/self-node
// without x-maw-from and expect success — meaning any change here is an API
// CONTRACT change, not a bugfix, and needs its own explicit review/approval
// (unlike the CLI fix, which restored an already-correctly-resolved value
// that was simply being discarded — there is no equivalent "already correct"
// signal to restore on the HTTP path without a header). Deferred whole to
// kobo-475, which already owns the deeper question (messageSignedRequest
// treats "header present" as "signed" with no authentication behind it at
// all). See PR #327 body for the full writeup.
