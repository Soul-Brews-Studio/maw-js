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

mock.module(join(root, "config"), () => mockConfigModule(() => ({
  node: "m5",
  agents: {},
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

beforeEach(() => {
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
});

async function trySend(from: string, target: string, message: string) {
  try {
    await cmdSend(target, message, false, { from, noVerifySubmit: true, receiverInbox: false });
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
