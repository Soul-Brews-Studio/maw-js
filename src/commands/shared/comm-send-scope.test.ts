/**
 * kobo-431 — company-scope gate on cmdSend (the CLI path notify.ts's real
 * task-event pings travel through: spawnHeyProcess → real `maw hey`
 * subprocess → this exact function). Mirrors sessions-send-scope.test.ts's
 * coverage of the same gate on the server /api/send path.
 *
 * Zero prior test coverage existed for comm-send.ts (checked before writing) —
 * this is a from-scratch mock.module() setup, not an extension of an existing
 * pattern for THIS file specifically (wake-resolve-impl.test.ts established
 * the mock.module(sdk) technique used here).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "path";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const root = join(import.meta.dir, "../..");
const { mockConfigModule } = await import("../../../test/helpers/mock-config");

let resolveTargetImpl: (q: string) => any = () => ({ type: "error", reason: "not_found", detail: "unset" });
let sendKeysMock = mock(async () => {});

const realSdk = await import(join(root, "sdk"));
mock.module(join(root, "sdk"), () => ({
  ...realSdk,
  listSessions: async () => [],
  sendKeys: (...args: any[]) => sendKeysMock(...args),
  resolveTarget: (q: string) => resolveTargetImpl(q),
}));

// kobo-474 — mutable so tests can simulate a node whose config.oracle IS set
// (the real live value on this box is literally "mawjs", but %11's finding
// is that ANY node with a real oracle name here is dangerous — T4 proves it).
let configOracle: string | undefined;
mock.module(join(root, "config"), () => mockConfigModule(() => ({
  node: "m5",
  agents: {},
  oracle: configOracle,
})));

const { cmdSend } = await import("./comm-send");
const { COMPANIES_DIR, _setCompaniesDir, saveCompany } = await import("../../vendor/mpr-plugins/company/company-helpers");
const { _clearScopeCache } = await import("../../core/worklog/company-scope");

const ORIGINAL_COMPANIES_DIR = COMPANIES_DIR;
const ORIGINAL_DATA_DIR = process.env.MAW_DATA_DIR;
const ORIGINAL_FETCH = globalThis.fetch;
let companiesTmp: string;
let dataTmp: string;

const pgw = () => ({
  name: "pgw",
  manager: "thawanban",
  teams: { core: { lead: "nai", members: [{ oracle: "nai", role: "lead" as const }, { oracle: "lek", role: "dev" as const }] } },
});
const kobo = () => ({
  name: "kobo",
  manager: "eq3",
  teams: { dev: { lead: "patchwork", members: [{ oracle: "patchwork", role: "dev" as const }] } },
});

const realExit = process.exit.bind(process);
const ORIGINAL_CLAUDE_AGENT_NAME = process.env.CLAUDE_AGENT_NAME;
const ORIGINAL_TMUX = process.env.TMUX;
const ORIGINAL_MAW_SENDER = process.env.MAW_SENDER;

beforeEach(() => {
  configOracle = undefined;
  // kobo-474 — resolveMyName (comm-send.ts:138) checks CLAUDE_AGENT_NAME
  // first; this test RUNS inside a real tmux pane on the dev box, so leaving
  // process.env.TMUX set would let resolveMyName fall through to a REAL tmux
  // session-name lookup if a test forgets to set CLAUDE_AGENT_NAME — delete
  // both here and require each "auto" test to set what it needs explicitly.
  delete process.env.CLAUDE_AGENT_NAME;
  delete process.env.TMUX;
  delete process.env.MAW_SENDER;
  // isPaneAway's companyOfOracleLight (presence-away.ts) is a barrel-free
  // twin that reads mawDataPath("companies") directly — it does NOT go
  // through the COMPANIES_DIR export _setCompaniesDir overrides. Left
  // unset, it falls through to the real ~/.maw/companies on the box, so the
  // "same-company send" test's away-check sees real fleet presence instead
  // of this test's fixtures (kobo-431 c2: flaky on any dev box where the
  // fixture oracle name collides with a real, actually-away oracle). Fix:
  // point MAW_DATA_DIR at the same temp root company-helpers writes into,
  // same as production where COMPANIES_DIR defaults to mawDataPath("companies").
  dataTmp = mkdtempSync(join(tmpdir(), "kobo431-cli-data-"));
  process.env.MAW_DATA_DIR = dataTmp;
  companiesTmp = join(dataTmp, "companies");
  mkdirSync(companiesTmp, { recursive: true });
  _setCompaniesDir(companiesTmp);
  _clearScopeCache();
  saveCompany(pgw() as any);
  saveCompany(kobo() as any);
  sendKeysMock = mock(async () => {});
  resolveTargetImpl = () => ({ type: "error", reason: "not_found", detail: "unset" });
  // cmdSend calls process.exit(1) on refusal — a REAL exit kills the whole
  // bun-test worker process (no pass/fail summary at all, confirmed by
  // running it before this fix: exit code 1, output just stops). Convert to
  // a throw so the test process survives and the refusal is observable.
  (process as any).exit = ((code?: number) => { throw new Error(`__PROCESS_EXIT_${code ?? 0}__`); }) as any;
  // checkBusyGuard (agent-status-guard.ts) falls through to a real fetch to
  // localhost:3456 when agentStatusStore has no entry — every target here.
  // On a box where that port isn't answering, that's a multi-second hang per
  // test (kobo-431/449). Stub only the TRANSPORT, same pattern as the
  // established test/isolated/agent-status-guard.test.ts: checkBusyGuard's
  // own decision logic still runs for real (store-miss → fetch fails fast →
  // not busy), so this cannot mask a broken busy-guard decision.
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
});
afterEach(() => {
  _setCompaniesDir(ORIGINAL_COMPANIES_DIR);
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = ORIGINAL_DATA_DIR;
  _clearScopeCache();
  try { rmSync(dataTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit = realExit;
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_CLAUDE_AGENT_NAME === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = ORIGINAL_CLAUDE_AGENT_NAME;
  if (ORIGINAL_TMUX === undefined) delete process.env.TMUX; else process.env.TMUX = ORIGINAL_TMUX;
  if (ORIGINAL_MAW_SENDER === undefined) delete process.env.MAW_SENDER; else process.env.MAW_SENDER = ORIGINAL_MAW_SENDER;
});

async function trySend(from: string, target: string, message: string) {
  try {
    await cmdSend(target, message, false, { from, noVerifySubmit: true, receiverInbox: false });
    return { exited: false as const };
  } catch (e: any) {
    return { exited: true as const, error: e };
  }
}

// kobo-474 — the property that triggers this whole bug class: source ===
// "auto". Every existing test above calls trySend(from, ...), which passes
// `from` into cmdSend's opts, which resolveSenderIdentity (comm-send.ts:265,
// "const explicit = opts.from?.trim()") reads as `explicit` → source:"flag".
// NONE of them ever exercise the "auto" branch aclSenderOracle only mis-
// resolves on. This helper omits `from` entirely — the real shape of a bare
// `maw hey <target> "msg"`, source:"auto" (comm-send.ts:286) — so callers
// must set process.env.CLAUDE_AGENT_NAME themselves to control who "auto"
// resolves to, exactly like resolveMyName (comm-send.ts:139) does for real.
async function trySendAuto(target: string, message: string) {
  try {
    await cmdSend(target, message, false, { noVerifySubmit: true, receiverInbox: false });
    return { exited: false as const };
  } catch (e: any) {
    return { exited: true as const, error: e };
  }
}

describe("cmdSend — company-scope gate on local/self-node delivery, CLI path (kobo-431)", () => {
  it("refuses cross-company: sendKeys is NEVER called", async () => {
    resolveTargetImpl = () => ({ type: "local", target: "nai-oracle:0" });
    await trySend("m5:patchwork", "nai", "hello"); // patchwork (kobo) → nai (pgw)
    expect(sendKeysMock).not.toHaveBeenCalled();
  });

  it("still delivers same-company sends — no regression on the hot path everyone uses", async () => {
    resolveTargetImpl = () => ({ type: "local", target: "lek-oracle:0" });
    await trySend("m5:nai", "lek", "hello"); // nai (pgw) → lek (pgw)
    expect(sendKeysMock).toHaveBeenCalledTimes(1);
  });

  it("Defect B FIXED — CLI path, same-company bare-name guess no longer silently 'succeeds' (kobo-431 Option C)", async () => {
    // This mirrors the server-path test that used to be CONFIRMED OPEN: the
    // deleted resolveLocalFallbackForUnknownNode guessed that unknown node
    // "othernode" meant this host and injected the live bare "lek" match
    // anyway — even same-company. With no `hostAliases` entry, an unknown
    // node now stays an error and cmdSend never calls sendKeys. Was: called.
    // Now: not called. That flip is the fix's proof.
    resolveTargetImpl = (q: string) => {
      if (q === "othernode:lek") return { type: "error", reason: "unknown_node", detail: "node 'othernode' not in namedPeers, peers, or hostAliases" };
      if (q === "lek") return { type: "local", target: "lek-oracle:0" };
      return { type: "error", reason: "not_found", detail: `'${q}' not found` };
    };
    await trySend("m5:nai", "othernode:lek", "hello");

    expect(sendKeysMock).not.toHaveBeenCalled();
  });

  it("order-guard (kobo-431 c2, kobo-424 pattern) — unregistered target still allows, pinning crossCompanyDeliveryRefusal(sender, target) call-site order", async () => {
    // crossCompanyDeliveryRefusal is NOT symmetric: it resolves the TARGET's
    // company, then checks the SENDER is a member of it. An unregistered
    // target (no company at all) is a documented KNOWN GAP that allows
    // through — see company-scope.ts's crossCompanyDeliveryRefusal comment.
    // The other two tests above stay refused/refused either way the call
    // site's two arguments are ordered (both fixture oracles are registered
    // in different companies, so the mismatch is symmetric — that's exactly
    // why a prior 8/8-green swap of the call site went undetected, kobo-431
    // c2). This fixture is asymmetric on purpose: only ONE side is
    // registered, so a swapped call site flips the outcome — unswapped
    // allows (sendKeys called), swapped would refuse (sendKeys never
    // called) because it'd instead ask "is the unregistered ghost oracle a
    // member of patchwork's company (kobo)?" and refuse.
    resolveTargetImpl = () => ({ type: "local", target: "ghost-oracle:0" }); // "ghost" is registered nowhere
    await trySend("m5:patchwork", "ghost", "hello"); // patchwork (kobo, registered) → ghost (unregistered)
    expect(sendKeysMock).toHaveBeenCalledTimes(1);
  });
});

// kobo-474 — every test above uses trySend(from, ...), which sets
// source:"flag" and never touches aclSenderOracle's "auto" branch. These use
// trySendAuto — the real shape of a bare `maw hey <target> "msg"` — the ONLY
// shape that actually exercises the bug. Fixtures are self-contained
// (pgw/kobo saved fresh per test above) — NONE of these depend on the real
// ~/.maw/companies/smoke375.json or its ambiguity (front's AC2): "patchwork"
// here is unambiguous (only ever saved into kobo in this file's fixtures),
// so these stay meaningful after smoke375.json is eventually deleted in a
// later card, unlike a test that happened to pass only via the ambiguous-
// target catch-and-allow gap.
describe("cmdSend — sender-identity resolution on the AUTO path, source==='auto' (kobo-474)", () => {
  it("T1: unambiguous target, sender's real (env-resolved) identity IS a genuine same-company member — must deliver", async () => {
    // Today: aclSenderOracle ignores the correctly-resolved "nai" and
    // substitutes config.oracle (undefined here → falls to the "mawjs"
    // literal) — "mawjs" is not a pgw member → wrongly refused.
    process.env.CLAUDE_AGENT_NAME = "nai"; // real sender, genuinely a pgw member
    resolveTargetImpl = () => ({ type: "local", target: "lek-oracle:0" }); // pgw target, unambiguous
    await trySendAuto("lek", "hello");
    expect(sendKeysMock).toHaveBeenCalledTimes(1);
  });

  it("T2 (regression guard, not proof of today's bug): unambiguous cross-company send still refuses after the identity fix lands", async () => {
    // This is expected to pass BOTH before and after the fix — its job is to
    // catch the fix accidentally loosening the gate itself (front/%11's
    // scope condition), not to demonstrate the bug. Real sender "nai" (pgw)
    // is genuinely not a kobo member either way.
    process.env.CLAUDE_AGENT_NAME = "nai";
    resolveTargetImpl = () => ({ type: "local", target: "patchwork-oracle:0" }); // kobo target, unambiguous in THIS file's isolated fixtures
    await trySendAuto("patchwork", "hello");
    expect(sendKeysMock).not.toHaveBeenCalled();
  });

  it("T3: sender identity that resolves to nothing registered ANYWHERE must fail with a message naming the resolved identity as the problem — not the generic cross-company string", async () => {
    // No CLAUDE_AGENT_NAME, no TMUX (both deleted in beforeEach) — resolveMyName
    // falls to its own bottom fallback (config.node || "cli") = "m5", which
    // isn't a member of any fixture company. Today this produces the SAME
    // generic "'X' is not in company 'Y'" string a real cross-company member
    // would get — indistinguishable from "you're a real oracle, wrong company"
    // vs "we don't actually know who you are." NEW behavior, not a revert —
    // will need its own implementation, not just the senderName swap.
    resolveTargetImpl = () => ({ type: "local", target: "lek-oracle:0" });
    // The refusal reason is printed via console.error, not carried on the
    // process.exit(1) mock's thrown message (that's just "__PROCESS_EXIT_1__") —
    // spy console.error to see what the operator actually sees.
    const errSpy = mock((..._args: unknown[]) => {});
    const realConsoleError = console.error;
    console.error = errSpy as any;
    let result: Awaited<ReturnType<typeof trySendAuto>>;
    try {
      result = await trySendAuto("lek", "hello");
    } finally {
      console.error = realConsoleError;
    }
    expect(sendKeysMock).not.toHaveBeenCalled();
    expect(result.exited).toBe(true);
    const printed = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(printed).toMatch(/sender|identity/i); // must name the SENDER as the problem, not just "not in company"
  });

  it("T4 (the scary one, %11/front's AC4): a node whose config.oracle is set to a REAL member of the target's own company must not silently authorize a DIFFERENT real sender", async () => {
    // ⚠️ DO NOT DELETE OR SKIP THIS TEST, EVEN THOUGH config.oracle IS
    // "mawjs" (nobody) ON EVERY NODE TODAY — that is exactly why it must stay.
    // Simulates the single-tenant-node case %11 flagged (kobo-471/474 c2):
    // config.oracle = "eq3" — a genuine, registered kobo member (not "mawjs",
    // which fails safe by accident since nobody owns that name). Real sender
    // (env-resolved) is "nai" — a genuine PGW member, NOT kobo. Pre-fix:
    // aclSenderOracle ignored "nai" entirely and substituted config.oracle
    // ("eq3") — eq3 IS a kobo member → WRONGLY ALLOWED. The real "nai" was
    // never checked at all. This is the silent-wrong-person case, not a mere
    // refusal-message defect: the send actually went through under someone
    // else's authorization.
    //
    // Why this guard is PERMANENT, not a today-only regression test: the
    // most "helpful" future fix anyone will propose for the mawjs symptom is
    // "just set config.oracle to a real oracle name" — it looks like a
    // one-line cleanup and it is the exact opposite. eq3 lead has broadcast
    // fleet-wide: never set config.oracle to a real name, never delete
    // smoke375.json, until this card is merged+deployed+verified live. This
    // test is the ONLY thing standing between "someone tries that" and it
    // silently shipping — kobo-471/kobo-474, same lesson as the missing
    // warning file that should have existed beside smoke375.json but didn't.
    // If you are refactoring aclSenderOracle later: this test must still
    // fail loud if the fix is ever reverted to trusting config.oracle.
    configOracle = "eq3"; // defence-in-depth guard, no current producer on THIS box (live config.oracle is "mawjs") — %11's correction, kobo-474 c2
    process.env.CLAUDE_AGENT_NAME = "nai"; // real sender — genuinely NOT a kobo member
    resolveTargetImpl = () => ({ type: "local", target: "patchwork-oracle:0" }); // kobo target, unambiguous
    await trySendAuto("patchwork", "hello");
    expect(sendKeysMock).not.toHaveBeenCalled(); // must refuse — real sender "nai" is not a kobo member
  });
});
