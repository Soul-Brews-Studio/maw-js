import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { provisionOracleHooks, hooksStatusForOracle, pruneOracleHooks, provisionOracleStatusline, setupWorklogHooks, SEAT_RESUME_COMMAND, SEAT_RESUME_MATCHER } from "./hook-setup";
import { saveCompany, _setCompaniesDir, COMPANIES_DIR } from "../../vendor/mpr-plugins/company/company-helpers";

// Per-oracle provisioning of the unified company-context hook set (worklog +
// company-policy). Isolated via a temp ghqRoot (repo dirs) + temp MAW_HOME (so
// ensureWorklogHookScripts writes the scripts into a sandbox, not ~/.config).
describe("per-oracle hook provisioning", () => {
  let ghq = "";
  let home = "";
  const origHome = process.env.MAW_HOME;

  beforeEach(() => {
    ghq = mkdtempSync(join(tmpdir(), "maw-prov-ghq-"));
    home = mkdtempSync(join(tmpdir(), "maw-prov-home-"));
    process.env.MAW_HOME = home;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = origHome;
    for (const d of [ghq, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  function mkRepo(oracle: string): string {
    const dir = join(ghq, `${oracle}-oracle`);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    return dir;
  }
  function readSettings(oracle: string): any {
    const p = join(ghq, `${oracle}-oracle`, ".claude", "settings.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  }
  function allCommands(settings: any): string[] {
    return Object.values(settings.hooks ?? {})
      .flat()
      .flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
  }

  it("skipped when repo dir absent (defer, never throws)", () => {
    expect(provisionOracleHooks("ghost", { ghqRoot: ghq })).toBe("skipped");
    expect(hooksStatusForOracle("ghost", { ghqRoot: ghq }).hasDir).toBe(false);
  });

  it("updated → alreadyOk (idempotent); installs the full unified set incl. policy", () => {
    mkRepo("alice");
    expect(provisionOracleHooks("alice", { ghqRoot: ghq })).toBe("updated");
    const st = hooksStatusForOracle("alice", { ghqRoot: ghq });
    expect(st.hasDir).toBe(true);
    expect(st.missing).toEqual([]);
    expect(st.installed).toContain("company-policy.sh");
    expect(st.installed.length).toBeGreaterThanOrEqual(4);
    expect(provisionOracleHooks("alice", { ghqRoot: ghq })).toBe("alreadyOk");
  });

  // kobo-295 — auto-seat: provisionOracleHooks wires the SessionStart seat-resume hook
  // fleet-wide (the AUTO path, distinct from the /seat UserPromptSubmit back-hook).
  function seatEntries(settings: any): any[] {
    return (settings?.hooks?.SessionStart ?? []).filter(
      (e: any) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => h.command === SEAT_RESUME_COMMAND),
    );
  }

  it("wires the SessionStart seat-resume hook (auto-seat) with the crew-skills command + matcher", () => {
    mkRepo("dave");
    provisionOracleHooks("dave", { ghqRoot: ghq });
    const entries = seatEntries(readSettings("dave"));
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe(SEAT_RESUME_MATCHER);
    expect(entries[0].hooks[0].command).toBe(SEAT_RESUME_COMMAND);
    // idempotent — second run adds no duplicate, reports alreadyOk
    expect(provisionOracleHooks("dave", { ghqRoot: ghq })).toBe("alreadyOk");
    expect(seatEntries(readSettings("dave"))).toHaveLength(1);
  });

  it("composes with a pre-existing crew-skills seat entry (same command) — no duplicate", () => {
    const dir = mkRepo("erin2");
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [
        { matcher: SEAT_RESUME_MATCHER, hooks: [{ type: "command", command: SEAT_RESUME_COMMAND }] },
      ] } }, null, 2),
    );
    // seat already current → provisionOracleHooks still installs the OTHER hooks (updated),
    // but leaves exactly ONE seat entry (idempotent by command — no eq3-style dup/migration).
    provisionOracleHooks("erin2", { ghqRoot: ghq });
    expect(seatEntries(readSettings("erin2"))).toHaveLength(1);
  });

  it("upgrades an old clear-only seat entry in place (kobo-268 matcher), no duplicate", () => {
    const dir = mkRepo("frank");
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [
        { matcher: "clear", hooks: [{ type: "command", command: SEAT_RESUME_COMMAND }] },
      ] } }, null, 2),
    );
    provisionOracleHooks("frank", { ghqRoot: ghq });
    const entries = seatEntries(readSettings("frank"));
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe(SEAT_RESUME_MATCHER); // clear → startup|resume|clear
  });

  it("dryRun reports updated but writes nothing", () => {
    mkRepo("bob");
    expect(provisionOracleHooks("bob", { ghqRoot: ghq, dryRun: true })).toBe("updated");
    expect(readSettings("bob")).toBeNull();
  });

  it("preserves pre-existing non-worklog hooks; prune strips only ours", () => {
    const dir = mkRepo("carol");
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/my/custom.sh" }] }] },
      }, null, 2),
    );
    provisionOracleHooks("carol", { ghqRoot: ghq });
    let cmds = allCommands(readSettings("carol"));
    expect(cmds).toContain("/my/custom.sh");
    expect(cmds.some((c) => c.includes("company-policy.sh"))).toBe(true);

    expect(pruneOracleHooks("carol", { ghqRoot: ghq })).toBe("pruned");
    cmds = allCommands(readSettings("carol"));
    expect(cmds).toContain("/my/custom.sh"); // foreign hook survives
    expect(cmds.some((c) => c.includes("company-policy.sh"))).toBe(false);
    expect(cmds.some((c) => c.includes("worklog-"))).toBe(false);

    expect(pruneOracleHooks("carol", { ghqRoot: ghq })).toBe("nothing");
  });

  it("prune skipped when repo dir absent", () => {
    expect(pruneOracleHooks("ghost", { ghqRoot: ghq })).toBe("skipped");
  });

  // kobo-295 — DRIFT PIN: core's seat-resume command/matcher MUST stay byte-identical to
  // crew-skills sync's, or the two wirings emit DIFFERENT SessionStart entries → duplicate
  // auto-seat (double presence-back + double re-orient). Idempotency is by command string,
  // so any divergence silently breaks the no-dup guarantee. Pin against crew-skills' source.
  it("seat-resume command/matcher stay identical to crew-skills sync (no-dup contract)", () => {
    const syncSrc = readFileSync(
      join(import.meta.dir, "../../vendor/mpr-plugins/crew-skills/sync.ts"),
      "utf8",
    );
    expect(SEAT_RESUME_COMMAND).toBe("bash $HOME/.claude/hooks/seat-resume.sh");
    expect(SEAT_RESUME_MATCHER).toBe("startup|resume|clear");
    expect(syncSrc).toContain(`SEAT_RESUME_COMMAND = "${SEAT_RESUME_COMMAND}"`);
    expect(syncSrc).toContain(`SEAT_RESUME_MATCHER = "${SEAT_RESUME_MATCHER}"`);
  });

  // kobo-104 — statusLine presence-capture provisioning (settings.json FIELD).
  describe("statusLine provisioning (presence capture)", () => {
    it("fresh install sets statusLine → maw-statusline.sh, no delegate arg", () => {
      mkRepo("dave");
      // isolate global: no project AND no global statusLine → maw default (kobo-106
      // added a global fallback, so "fresh" now means neither source has one).
      const noGlobal = { ghqRoot: ghq, globalSettingsPath: join(home, "none.json") };
      expect(provisionOracleStatusline("dave", noGlobal)).toBe("updated");
      const cmd = readSettings("dave").statusLine.command as string;
      expect(cmd).toContain("maw-statusline.sh");
      expect(cmd.trim().endsWith("maw-statusline.sh")).toBe(true); // nothing wrapped → no arg
      // idempotent — already ours, never re-wraps
      expect(provisionOracleStatusline("dave", noGlobal)).toBe("alreadyOk");
    });

    it("WRAPS a pre-existing statusLine (RTK/token) instead of clobbering it", () => {
      const dir = mkRepo("erin");
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ statusLine: { type: "command", command: "rtk statusline --fancy" } }, null, 2),
      );
      expect(provisionOracleStatusline("erin", { ghqRoot: ghq })).toBe("updated");
      const cmd = readSettings("erin").statusLine.command as string;
      expect(cmd).toContain("maw-statusline.sh");
      // the original command survives — base64-encoded as maw-statusline.sh's arg
      const arg = cmd.split(/\s+/).pop()!;
      expect(Buffer.from(arg, "base64").toString("utf8")).toBe("rtk statusline --fancy");
      // idempotent — a second pass sees it's already wrapped, no double-encode
      expect(provisionOracleStatusline("erin", { ghqRoot: ghq })).toBe("alreadyOk");
    });

    it("dryRun reports updated but writes nothing; skipped when repo absent", () => {
      mkRepo("frank");
      expect(provisionOracleStatusline("frank", { ghqRoot: ghq, dryRun: true })).toBe("updated");
      expect(readSettings("frank")).toBeNull();
      expect(provisionOracleStatusline("ghost", { ghqRoot: ghq })).toBe("skipped");
    });

    // kobo-106 — wrap the EFFECTIVE statusLine = project ?? global. Agents with no
    // project statusLine keep theirs in ~/.claude/settings.json; wrapping only the
    // project would drop it under maw's default.
    describe("effective statusLine (project ?? global)", () => {
      // helper: write a fake global ~/.claude/settings.json into a temp file
      function mkGlobal(command: string | null): string {
        const p = join(home, "global-settings.json");
        writeFileSync(p, JSON.stringify(command ? { statusLine: { type: "command", command } } : {}, null, 2));
        return p;
      }

      it("case 2 — project empty + global present → wraps the GLOBAL command", () => {
        mkRepo("gwen"); // no project statusLine
        const globalPath = mkGlobal("~/.claude/limit-tracker.sh");
        expect(provisionOracleStatusline("gwen", { ghqRoot: ghq, globalSettingsPath: globalPath })).toBe("updated");
        const cmd = readSettings("gwen").statusLine.command as string;
        expect(cmd).toContain("maw-statusline.sh");
        const arg = cmd.split(/\s+/).pop()!;
        expect(Buffer.from(arg, "base64").toString("utf8")).toBe("~/.claude/limit-tracker.sh"); // global, not empty
        // idempotent — project is now maw, second pass skips
        expect(provisionOracleStatusline("gwen", { ghqRoot: ghq, globalSettingsPath: globalPath })).toBe("alreadyOk");
      });

      it("case 1 — project statusLine present → wraps PROJECT, ignores global", () => {
        const dir = mkRepo("heidi");
        writeFileSync(
          join(dir, ".claude", "settings.json"),
          JSON.stringify({ statusLine: { type: "command", command: "bash .claude/statusline.sh" } }, null, 2),
        );
        const globalPath = mkGlobal("~/.claude/limit-tracker.sh");
        expect(provisionOracleStatusline("heidi", { ghqRoot: ghq, globalSettingsPath: globalPath })).toBe("updated");
        const arg = (readSettings("heidi").statusLine.command as string).split(/\s+/).pop()!;
        expect(Buffer.from(arg, "base64").toString("utf8")).toBe("bash .claude/statusline.sh"); // project wins
      });

      it("case 3 — neither project nor global → maw default, no delegate", () => {
        mkRepo("ivan");
        const globalPath = mkGlobal(null); // global exists but has no statusLine
        expect(provisionOracleStatusline("ivan", { ghqRoot: ghq, globalSettingsPath: globalPath })).toBe("updated");
        const cmd = readSettings("ivan").statusLine.command as string;
        expect(cmd.trim().endsWith("maw-statusline.sh")).toBe(true); // nothing wrapped
      });

      it("edge — global is ALREADY maw-wrapped → never wrap maw-in-maw", () => {
        mkRepo("judy");
        const globalPath = mkGlobal("/some/path/maw-statusline.sh SGVsbG8="); // global already ours
        expect(provisionOracleStatusline("judy", { ghqRoot: ghq, globalSettingsPath: globalPath })).toBe("updated");
        const cmd = readSettings("judy").statusLine.command as string;
        expect(cmd.trim().endsWith("maw-statusline.sh")).toBe(true); // no delegate — not double-wrapped
      });

      it("missing global settings file → treated as no global (maw default)", () => {
        mkRepo("karl");
        expect(provisionOracleStatusline("karl", { ghqRoot: ghq, globalSettingsPath: join(home, "nope.json") })).toBe("updated");
        const cmd = readSettings("karl").statusLine.command as string;
        expect(cmd.trim().endsWith("maw-statusline.sh")).toBe(true);
      });
    });
  });
});

// kobo-290 — company-level setup-hooks must reach the MANAGER (lead) pane, not
// just dept members. The lead was skipped because companyOracles() enumerated
// departments[].members only → its /toilet never set away and /seat never
// cleared it (board-lie both directions). setup-hooks now provisions the lead
// too, with the toilet-away + seat-back PAIR.
describe("company-level setup-hooks includes the manager (kobo-290)", () => {
  let ghq = "";
  let home = "";
  const origHome = process.env.MAW_HOME;
  const origCompanies = COMPANIES_DIR;
  let companiesDir = "";

  beforeEach(() => {
    ghq = mkdtempSync(join(tmpdir(), "maw-mgr-ghq-"));
    home = mkdtempSync(join(tmpdir(), "maw-mgr-home-"));
    companiesDir = mkdtempSync(join(tmpdir(), "maw-mgr-companies-"));
    process.env.MAW_HOME = home;
    _setCompaniesDir(companiesDir);
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = origHome;
    _setCompaniesDir(origCompanies);
    for (const d of [ghq, home, companiesDir]) if (d) rmSync(d, { recursive: true, force: true });
  });

  function mkRepo(oracle: string): void {
    mkdirSync(join(ghq, `${oracle}-oracle`, ".claude"), { recursive: true });
  }
  function installedFor(oracle: string): string[] {
    return hooksStatusForOracle(oracle, { ghqRoot: ghq }).installed;
  }

  it("provisions the manager with the toilet-away + seat-back PAIR (manager NOT a dept member)", () => {
    saveCompany({
      name: "pgw",
      manager: "thawanban",
      departments: {
        core: { kbTag: "dept:pgw:core", lead: "nai", members: [{ oracle: "nai", role: "lead" }, { oracle: "lek", role: "dev" }] },
      },
    });
    for (const o of ["thawanban", "nai", "lek"]) mkRepo(o);

    const res = setupWorklogHooks({ company: "pgw", ghqRoot: ghq });
    expect(res.updated).toContain("thawanban"); // the manager was reached (was skipped before kobo-290)

    const mgr = installedFor("thawanban");
    expect(mgr).toContain("toilet-away.sh"); // PAIR — away half
    expect(mgr).toContain("seat-back.sh");   // PAIR — back half
  });

  it("dedups a manager who is also a dept member — reached once, not twice", () => {
    saveCompany({
      name: "kobo",
      manager: "eq3",
      departments: {
        core: { kbTag: "dept:kobo:core", lead: "eq3", members: [{ oracle: "eq3", role: "lead" }, { oracle: "patchwork", role: "dev" }] },
      },
    });
    for (const o of ["eq3", "patchwork"]) mkRepo(o);

    const res = setupWorklogHooks({ company: "kobo", ghqRoot: ghq });
    const reached = [...res.updated, ...res.alreadyOk, ...res.skipped];
    expect(reached.filter(o => o === "eq3")).toHaveLength(1); // provisioned once, not duplicated

    const mgr = installedFor("eq3");
    expect(mgr).toContain("toilet-away.sh");
    expect(mgr).toContain("seat-back.sh");
  });
});
