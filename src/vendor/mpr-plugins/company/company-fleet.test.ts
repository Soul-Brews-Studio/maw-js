/**
 * `maw company up/down <company>` — behavior tests (kobo-362). Dependency
 * injection (not mock.module) — mirrors room-client.ts's DI-deps style, no
 * global module mocking needed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { companyUp, companyDown, runCompanyUp, runCompanyDown, type CompanyFleetDeps } from "./company-fleet";
import { _setCompaniesDir, saveCompany, COMPANIES_DIR } from "./company-helpers";
import type { Session } from "maw-js/sdk";
import type { TeardownResult } from "../crew/teardown";

const origCompaniesDir = COMPANIES_DIR;
let dir: string;
const prevTmuxPane = process.env.TMUX_PANE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-companyfleet-"));
  _setCompaniesDir(dir);
});
afterEach(() => {
  _setCompaniesDir(origCompaniesDir);
  rmSync(dir, { recursive: true, force: true });
  if (prevTmuxPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = prevTmuxPane;
});

// ── fakes ─────────────────────────────────────────────────────────────────────

function fakeSessions(entries: Record<string, string[]>): Session[] {
  return Object.entries(entries).map(([name, windowNames]) => ({
    name,
    windows: windowNames.map((wn, i) => ({ index: i, name: wn, active: i === 0 })),
  }));
}

interface PaneFixture { paneId: string; role: string }

function makeDeps(opts: {
  sessions?: Session[];
  panesBySession?: Record<string, PaneFixture[]>;
  busy?: Record<string, boolean>;
  wakeFails?: Set<string>;
  wakeCreatesSession?: (oracle: string) => Session | null; // simulate cold-start side effect
  teardownResult?: TeardownResult;
} = {}): { deps: CompanyFleetDeps; calls: string[] } {
  const calls: string[] = [];
  let sessions = opts.sessions ?? [];
  const panesBySession = opts.panesBySession ?? {};
  const busy = opts.busy ?? {};

  const deps: CompanyFleetDeps = {
    hostExecFn: async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("tmux list-panes")) {
        const m = cmd.match(/-t\s+'([^']+)'/);
        const session = m?.[1] ?? "";
        const panes = panesBySession[session] ?? [];
        return panes.map((p) => `${p.paneId}|||${p.role}`).join("\n");
      }
      return "";
    },
    listSessionsFn: async () => sessions,
    findWindowFn: (sess: Session[], query: string) => {
      const s = sess.find((x) => x.name.replace(/^\d+-/, "") === query);
      if (!s) return null;
      return `${s.name}:${s.windows[0]?.index ?? 0}`;
    },
    checkBusyGuardFn: async (oracle: string) => ({ busy: !!busy[oracle], status: busy[oracle] ? "busy" : "idle", oracle } as any),
    teardownCrewWindowsFn: async (o: { protectPaneId: string }) =>
      opts.teardownResult ?? { ok: true, killed: [], logs: [`no leftover crew panes — clean spawn (protect=${o.protectPaneId})`] },
    cmdWakeFn: async (oracle: string) => {
      calls.push(`wake:${oracle}`);
      if (opts.wakeFails?.has(oracle)) throw new Error("oracle repo not found");
      const created = opts.wakeCreatesSession?.(oracle);
      if (created) sessions = [...sessions, created];
      return "ok";
    },
  };
  return { deps, calls };
}

// ── companyUp ─────────────────────────────────────────────────────────────────

describe("companyUp (kobo-362)", () => {
  test("company not found → error", async () => {
    const { deps } = makeDeps();
    const r = await companyUp("ghost", () => {}, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("company not found");
  });

  test("no company name → usage error", async () => {
    const { deps } = makeDeps();
    const r = await companyUp(undefined, () => {}, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage");
  });

  test("no manager set → loud report, every member treated as crew-front", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "eq3", role: "lead" }] } } });
    const lines: string[] = [];
    const { deps } = makeDeps({
      sessions: fakeSessions({ "05-eq3": ["main"] }),
      panesBySession: { "05-eq3": [
        { paneId: "%1", role: "🧭 coord" }, { paneId: "%2", role: "🎼 conductor" },
        { paneId: "%3", role: "⚒ worker" }, { paneId: "%4", role: "🔎 reviewer" },
      ] },
    });
    await companyUp("kobo", (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("no company head"))).toBe(true);
    expect(lines.some((l) => l.includes("eq3: crew ready — skip"))).toBe(true);
  });

  test("member with complete crew-front → skip", async () => {
    saveCompany({ name: "kobo", manager: "eq3", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps } = makeDeps({
      sessions: fakeSessions({ "05-eq3": ["main"], "13-patchwork": ["main"] }),
      panesBySession: {
        "05-eq3": [{ paneId: "%1", role: "👤 lead" }, { paneId: "%2", role: "🎼 conductor" }, { paneId: "%3", role: "🔎 reviewer" }],
        "13-patchwork": [
          { paneId: "%4", role: "🧭 coord" }, { paneId: "%5", role: "🎼 conductor" },
          { paneId: "%6", role: "⚒ worker" }, { paneId: "%7", role: "🔎 reviewer" },
        ],
      },
    });
    await companyUp("kobo", (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("eq3: head-cell ready — skip"))).toBe(true);
    expect(lines.some((l) => l.includes("patchwork: crew ready — skip"))).toBe(true);
  });

  test("manager head-cell incomplete → LOUD report-only, no auto head-spawn", async () => {
    saveCompany({ name: "kobo", manager: "eq3", teams: {} });
    const lines: string[] = [];
    const { deps, calls } = makeDeps({
      sessions: fakeSessions({ "05-eq3": ["main"] }),
      panesBySession: { "05-eq3": [{ paneId: "%1", role: "👤 lead" }] }, // conductor+reviewer missing
    });
    await companyUp("kobo", (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("manager head-cell INCOMPLETE"))).toBe(true);
    expect(lines.some((l) => l.includes("kobo-364"))).toBe(true);
    expect(calls.some((c) => c.includes("send-keys"))).toBe(false); // no injection for manager — report-only
  });

  test("crew-front member incomplete → repairs via injected crew spawn", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps, calls } = makeDeps({
      sessions: fakeSessions({ "13-patchwork": ["main"] }),
      panesBySession: { "13-patchwork": [{ paneId: "%1", role: "🧭 coord" }] }, // conductor/worker/reviewer missing
    });
    await companyUp("kobo", (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("repairing"))).toBe(true);
    expect(calls.some((c) => c.includes("send-keys -t '%1'") && c.includes("maw company crew spawn kobo"))).toBe(true);
  });

  test("crew-front member with NO session → session-tier cold-start via cmdWake, then repairs", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "charlie", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps, calls } = makeDeps({
      sessions: [],
      panesBySession: { "04-charlie": [] }, // freshly created, no crew panes yet
      wakeCreatesSession: (oracle) => (oracle === "charlie" ? fakeSessions({ "04-charlie": ["main"] })[0] : null),
    });
    await companyUp("kobo", (l) => lines.push(l), deps);
    expect(calls).toContain("wake:charlie");
    expect(lines.some((l) => l.includes("session created"))).toBe(true);
    // no @role-tagged pane exists yet (fresh session) → injection falls back to the resolved window itself
    expect(calls.some((c) => c.includes("send-keys -t '04-charlie:0'") && c.includes("maw company crew spawn kobo"))).toBe(true);
  });

  test("cmdWake throws (never set up) → LOUD report, no retry/guess", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "ghost-oracle", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps } = makeDeps({ sessions: [], wakeFails: new Set(["ghost-oracle"]) });
    await companyUp("kobo", (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("wake failed") && l.includes("never set up"))).toBe(true);
  });

  test("manager with no session at all → report-only, does NOT cold-start (no head-spawn to fill it)", async () => {
    saveCompany({ name: "kobo", manager: "eq3", teams: {} });
    const lines: string[] = [];
    const { deps, calls } = makeDeps({ sessions: [] });
    await companyUp("kobo", (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("manager has no session"))).toBe(true);
    expect(calls.some((c) => c.startsWith("wake:"))).toBe(false);
  });

  test("re-run after repair is idempotent — a now-complete crew skips", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps } = makeDeps({
      sessions: fakeSessions({ "13-patchwork": ["main"] }),
      panesBySession: { "13-patchwork": [
        { paneId: "%1", role: "🧭 coord" }, { paneId: "%2", role: "🎼 conductor" },
        { paneId: "%3", role: "⚒ worker" }, { paneId: "%4", role: "🔎 reviewer" },
      ] },
    });
    await companyUp("kobo", (l) => lines.push(l), deps);
    await companyUp("kobo", (l) => lines.push(l), deps);
    expect(lines.filter((l) => l.includes("crew ready — skip"))).toHaveLength(2);
  });

  test("runCompanyUp CLI-arg wrapper parses the company name positional", async () => {
    saveCompany({ name: "kobo", teams: {} });
    const lines: string[] = [];
    const r = await runCompanyUp(["kobo"], (l) => lines.push(l));
    expect(r.ok).toBe(true);
  });
});

// ── companyDown ───────────────────────────────────────────────────────────────

describe("companyDown (kobo-362)", () => {
  test("company not found → error", async () => {
    const { deps } = makeDeps();
    const r = await companyDown("ghost", {}, () => {}, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("company not found");
  });

  test("member with no session → nothing to tear down, no crash", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "asleep", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps } = makeDeps({ sessions: [] });
    const r = await companyDown("kobo", {}, (l) => lines.push(l), deps);
    expect(r.ok).toBe(true);
    expect(lines.some((l) => l.includes("nothing to tear down"))).toBe(true);
  });

  test("busy member → REFUSED by default (no --force)", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps } = makeDeps({
      sessions: fakeSessions({ "13-patchwork": ["main"] }),
      panesBySession: { "13-patchwork": [{ paneId: "%1", role: "🧭 coord" }] },
      busy: { patchwork: true },
    });
    await companyDown("kobo", {}, (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("BUSY") && l.includes("--force"))).toBe(true);
  });

  test("--force overrides the busy refusal and tears down anyway", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps, calls } = makeDeps({
      sessions: fakeSessions({ "13-patchwork": ["main"] }),
      panesBySession: { "13-patchwork": [{ paneId: "%1", role: "🧭 coord" }] },
      busy: { patchwork: true },
    });
    process.env.TMUX_PANE = "%not-this-one";
    await companyDown("kobo", { force: true }, (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("BUSY"))).toBe(false);
    expect(calls.some((c) => c.includes("kill-pane -t '%1'"))).toBe(true);
  });

  test("tears down crew-tier (358 helper) then kills the front/lead pane", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps, calls } = makeDeps({
      sessions: fakeSessions({ "13-patchwork": ["main"] }),
      panesBySession: { "13-patchwork": [{ paneId: "%1", role: "🧭 coord" }] },
    });
    process.env.TMUX_PANE = "%operator";
    await companyDown("kobo", {}, (l) => lines.push(l), deps);
    expect(calls.some((c) => c.includes("kill-pane -t '%1'"))).toBe(true);
    expect(lines.some((l) => l.includes("killed front/lead pane"))).toBe(true);
  });

  test("front/lead pane IS the global invoker → protected, not killed", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps, calls } = makeDeps({
      sessions: fakeSessions({ "13-patchwork": ["main"] }),
      panesBySession: { "13-patchwork": [{ paneId: "%1", role: "🧭 coord" }] },
    });
    process.env.TMUX_PANE = "%1"; // the invoker IS this member's own front pane
    await companyDown("kobo", {}, (l) => lines.push(l), deps);
    expect(calls.some((c) => c.includes("kill-pane -t '%1'"))).toBe(false);
    expect(lines.some((l) => l.includes("IS the invoker — protected"))).toBe(true);
  });

  test("teardown helper refuses (fail-closed) → reported, no kill", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps, calls } = makeDeps({
      sessions: fakeSessions({ "13-patchwork": ["main"] }),
      panesBySession: { "13-patchwork": [{ paneId: "%1", role: "🧭 coord" }] },
      teardownResult: { ok: false, error: "can't list panes — fail-closed", killed: [], logs: [] },
    });
    await companyDown("kobo", {}, (l) => lines.push(l), deps);
    expect(lines.some((l) => l.includes("teardown refused"))).toBe(true);
    expect(calls.some((c) => c.includes("kill-pane"))).toBe(false);
  });

  test("2x idempotent — second down on an already-torn-down (no-session) company is a clean no-op", async () => {
    saveCompany({ name: "kobo", teams: { core: { members: [{ oracle: "patchwork", role: "dev" }] } } });
    const lines: string[] = [];
    const { deps } = makeDeps({ sessions: [] }); // already down — no sessions left
    const first = await companyDown("kobo", {}, (l) => lines.push(l), deps);
    const second = await companyDown("kobo", {}, (l) => lines.push(l), deps);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  test("runCompanyDown CLI-arg wrapper parses --force and the company positional in either order", async () => {
    saveCompany({ name: "kobo", teams: {} });
    const r1 = await runCompanyDown(["kobo", "--force"], () => {});
    const r2 = await runCompanyDown(["--force", "kobo"], () => {});
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});
