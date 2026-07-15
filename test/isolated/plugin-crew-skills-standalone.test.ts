import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { SYNC_ITEMS, ensureSeatResumeHook, formatSyncResult, syncCrewSkills } from "../../src/vendor/mpr-plugins/crew-skills/sync.ts?plugin-crew-skills-standalone";

const pluginRoot = join(import.meta.dir, "../../src/vendor/mpr-plugins/crew-skills");
const assetsDir = join(pluginRoot, "assets");
const tmpRoots: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "crew-skills-home-"));
  tmpRoots.push(home);
  return home;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("crew-skills plugin standalone boundary", () => {
  test("sync keeps explicit standalone import boundaries (no deep maw-js coupling)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "crew-skills",
      allowRelative: ["./sync"],
    }).map((record) => record.spec);
    // sync.ts is pure node:fs — the whole point is zero core/config coupling.
    expect(imports).toContain("node:fs");
  });

  test("declares a passthrough cli command, no serve hook", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));
    expect(manifest.cli.command).toBe("crew-skills");
    expect(manifest.hooks).toBeUndefined();
  });
});

describe("crew-skills global asset contract", () => {
  // The worker spawn contract is deadlock-critical (kobo-91): a worker with no
  // Stop hook never signals idle. Global install only works if the settings +
  // hook are addressed by $HOME-absolute paths, not cwd-relative ones.
  test("worker settings points the Stop hook at a $HOME-absolute path", () => {
    const settings = readFileSync(join(assetsDir, "crew-worker-settings.json"), "utf8");
    expect(settings).toContain("$HOME/.claude/hooks/crew-worker-stop.sh");
    expect(settings).not.toContain('"bash .claude/hooks');
    // still valid JSON with a Stop hook
    const parsed = JSON.parse(settings);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("$HOME/.claude/hooks/crew-worker-stop.sh");
  });

  // kobo-196/268 — worker panes spawn with crew-worker-settings.json (not the repo's
  // settings), so the auto-seat SessionStart hook must ride this asset too to cover them
  // (scoped-both: repo settings → lead/comm/conductor, this → workers). kobo-268: the
  // matcher fires on startup|resume|clear (not clear-only) so a worker auto-seats on every
  // (re)start, not just after /clear.
  test("worker settings carries the SessionStart seat-resume hook (startup|resume|clear)", () => {
    const parsed = JSON.parse(readFileSync(join(assetsDir, "crew-worker-settings.json"), "utf8"));
    const entry = parsed.hooks.SessionStart.find((e: any) => e.matcher === "startup|resume|clear");
    expect(entry.hooks[0].command).toBe("bash $HOME/.claude/hooks/seat-resume.sh");
  });

  // kobo-268 — the seat-resume hook is a synced executable asset that resolves the resume
  // file from the crew env (CREW_STATE_DIR/CREW_ROLE, like the Stop hook) so it seats BOTH
  // crew (ψ/active/crew/worker-1.md) and warroom (ψ/active/warroom, lead-handoff.md) layouts.
  test("seat-resume hook is a synced executable + resolves crew env AND warroom fallback", () => {
    const item = SYNC_ITEMS.find((i) => i.dest === "hooks/seat-resume.sh");
    expect(item).toBeDefined();
    expect(item?.exec).toBe(true);
    const hook = readFileSync(join(assetsDir, "hooks/seat-resume.sh"), "utf8");
    expect(hook).toContain("CREW_STATE_DIR"); // env-first (mirrors the Stop hook)
    expect(hook).toContain("CREW_ROLE");
    expect(hook).toContain("@role"); // durable tmux fallback
    expect(hook).toContain("$STEM.md"); // crew's role-named file (worker-1.md)
    expect(hook).toContain("lead-handoff.md"); // eq3 fix + warroom special name
    expect(hook).toContain("ψ/active/crew"); // seats the crew layout too (patchwork dogfood)
    expect(hook).toContain("ψ/active/worker"); // kobo-316: worker fallback dir
    expect(hook).toContain("exit 0"); // solo-safe guards (no dir / no role → silent)
    // kobo-269 fix: when no CREW_STATE_DIR, search BOTH dirs and let the dir that HOLDS the
    // role file win — an empty leftover crew/ must not shadow a populated warroom/ (lead no-seat).
    expect(hook).toContain('for d in $DIRS'); // dir-selection loops both dirs, not blind-pick
    expect(hook).toContain("break 2"); // first dir with a matching file wins
    // kobo-268 fix: the case globs are case-sensitive, but labels are capitalized
    // ("🎼 Conductor") — the stem MUST be lowercased or Conductor never matches conduct*.
    expect(hook).toContain("tr '[:upper:]' '[:lower:]'");
    expect(hook).toContain("conduct*"); // the capitalized-label role this fix rescues
    // kobo-297 — auto-seat is observable: a visible boot-line right after `maw presence back`
    // confirms the pane re-seated online (the flip was otherwise a silent background write).
    expect(hook).toContain("presence: online (auto-seated)");
  });

  // kobo-174/200 — the lead card-gate hook ships as an executable global asset so an
  // oracle that opts in (via .maw/card-gate.json) points at a real script.
  test("card-gate hook is a synced executable asset", () => {
    const item = SYNC_ITEMS.find((i) => i.dest === "hooks/maw-card-gate.sh");
    expect(item).toBeDefined();
    expect(item?.exec).toBe(true);
    const hook = readFileSync(join(assetsDir, "hooks/maw-card-gate.sh"), "utf8");
    // gates BOTH paths (MCP-gap lesson) + fail-CLOSED + opt-in + conscious override
    expect(hook).toContain("mcp__maw__maw_task");
    expect(hook).toContain("maw task add");
    expect(hook).toContain(".maw/card-gate.json"); // kobo-200: CC-safe config source
    expect(hook).toContain(".mawCardGate");        // legacy settings.json fallback still read
    expect(hook).toContain("--force-lead");
    expect(hook).toContain('"deny"');
  });

  // kobo-200 — a dormant sample config ships so adopters can copy it to
  // <repo>/.maw/card-gate.json. It must install to ~/.claude (NOT .maw/) so the
  // hook never reads it → sync never auto-activates the gate for everyone.
  test("card-gate sample ships as a dormant asset (never the live .maw path)", () => {
    const item = SYNC_ITEMS.find((i) => i.dest === "card-gate.sample.json");
    expect(item).toBeDefined();
    expect(item?.dest).not.toContain(".maw"); // dormant — hook reads .maw/card-gate.json, not this
    const sample = JSON.parse(readFileSync(join(assetsDir, "card-gate.sample.json"), "utf8"));
    expect(sample.leadRole).toBe("lead");
    expect(sample.gatedTools).toContain("maw_task add");
  });

  test("crew skill spawns workers with the $HOME-absolute settings path", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(skill).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
    expect(skill).not.toContain("--settings .claude/crew-worker-settings.json");
  });

  // kobo-282 regress guard — the front @role tag has broken THREE times (270→271→281):
  // it must live in §0 init (fires on every /crew, incl a STANDBY front with 0 workers)
  // AND after the company-gate refuse (a refused /crew exits before it tags — no stale
  // coord). Pin both invariants by position so a future eye can't silently re-break it.
  test("front @role tag is baked at §0 init — after company-gate refuse, before §1 spawn (kobo-282)", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    const tagIdx = skill.indexOf('set-option -p -t "$TMUX_PANE" @role "🧭 coord"');
    const refuseIdx = skill.indexOf("crew ต้องอยู่ใน company"); // §0 company-gate refuse (exit)
    const spawnIdx = skill.indexOf("## 1. Spawn"); // worker-spawn section (§1 Layout was the old home)
    expect(tagIdx).toBeGreaterThan(-1);
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(-1);
    expect(tagIdx).toBeGreaterThan(refuseIdx); // refused /crew exits before tagging → no stale coord
    expect(tagIdx).toBeLessThan(spawnIdx); // unconditional at init, NOT deferred to worker-spawn (kobo-270 gap)
    // single source — the old §1 Layout copy (tagged $COORD) is gone
    expect(skill).not.toContain('set-option -p -t "$COORD" @role "🧭 coord"');
  });

  // kobo-303 — /warroom hard-removed; /head is the coord skill that spawns workers now.
  // Same global path requirement (kobo-94): a bare/relative --settings re-opens the
  // deadlock once local .claude/ copies are removed.
  test("head skill has no cwd-relative crew-worker-settings reference", () => {
    const skill = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    expect(skill).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
    expect(skill).not.toContain("--settings .claude/crew-worker-settings.json");
    // no bare relative "crew-worker-settings.json" (only the $HOME-absolute form)
    for (const m of skill.matchAll(/crew-worker-settings\.json/g)) {
      const before = skill.slice(Math.max(0, m.index! - 20), m.index!);
      expect(before).toContain("$HOME/.claude/");
    }
  });

  // kobo-95/303 — /head reviewer+scratchpad write to ψ/active/head/ — the hook state hint
  // must follow via CREW_STATE_DIR, or a coord that trusts the hint reads the wrong path.
  test("head spawn sets CREW_STATE_DIR and hook honors it", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    expect(head).toContain("CREW_STATE_DIR=ψ/active/head");

    const hook = readFileSync(join(assetsDir, "hooks/crew-worker-stop.sh"), "utf8");
    expect(hook).toContain("${CREW_STATE_DIR:-ψ/active/crew}/$CREW_ROLE.md");
    // no lingering hardcoded crew path in the hint
    expect(hook).not.toContain("state: ψ/active/crew/$CREW_ROLE.md");
  });

  // kobo-150: crew SKILL forwards CREW_STATE_DIR (default ψ/active/crew, warroom
  // overrides to ψ/active/warroom) so the same spawn form works under the Conductor (kobo-157 rename).
  test("crew skill forwards CREW_STATE_DIR with the default state dir", () => {
    const crew = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(crew).toContain("${CREW_STATE_DIR:-ψ/active/crew}");
    expect(crew).toContain("CREW_STATE_DIR=");
  });

  // kobo-267: both spawns must stamp MAW_ROOM_COMPANY (from the company name crew
  // §0 resolves) so the statusline self-describes company → /api/presence?company=
  // can scope. Drop the stamp and the pane silently falls out of its board's
  // presence query, so guard it here (this is a CI-only isolated content gate).
  test("crew + head spawns stamp MAW_ROOM_COMPANY for presence scoping", () => {
    const crew = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(crew).toContain("CO_NAME="); // company name resolved in §0
    expect(crew).toContain("MAW_ROOM_COMPANY=");
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    expect(head).toContain("MAW_ROOM_COMPANY=");
  });

  // kobo-303 CUTOVER — /head (3-tier) replaced /warroom, which is now hard-removed.
  // /head + /crew + /worker ship; /warroom is neither a sync item nor an asset file. The seat-resume
  // hook KEEPS its warroom-dir support (asserted above) so any still-running warroom pane
  // survives the skill removal — the skill file is gone, the runtime survival path is not.
  test("head + crew + worker ship; /warroom is fully removed (kobo-303 cutover)", () => {
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/head/SKILL.md")).toBeDefined();
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/crew/SKILL.md")).toBeDefined();
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/worker/SKILL.md")).toBeDefined(); // kobo-316
    // /warroom hard-removed: no sync item, no asset file
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/warroom/SKILL.md")).toBeUndefined();
    expect(existsSync(join(assetsDir, "skills/warroom/SKILL.md"))).toBe(false);
  });

  // kobo-316 — /worker = self-invoked leaf execution (no spawn). Ships as a SYNC_ITEM so any
  // oracle can invoke /worker to declare itself as a worker without being spawned by a coordinator.
  // Key invariants: state-dir at ψ/active/worker, pings coordinator on ready, re-seats on /clear,
  // never spawns sub-panes (leaf).
  test("worker skill is a synced asset with correct key content (kobo-316)", () => {
    const item = SYNC_ITEMS.find((i) => i.dest === "skills/worker/SKILL.md");
    expect(item).toBeDefined();
    const skill = readFileSync(join(assetsDir, "skills/worker/SKILL.md"), "utf8");
    // self-invoked: oracle declares itself worker (not spawned from above)
    expect(skill).toContain("self-invoked");
    expect(skill).toContain("leaf");
    // state dir default
    expect(skill).toContain("ψ/active/worker");
    // pings coordinator ready
    expect(skill).toContain("worker ready");
    // re-seat via seat-resume.sh
    expect(skill).toContain("seat-resume");
    // no spawn (leaf invariant)
    expect(skill).toContain("NO children");
    // card-lifecycle: worker drives state, never self-closes
    expect(skill).toContain("move card review");
    // no run_in_background guard (worker contract)
    expect(skill).toContain("run_in_background");
  });

  test("head skill spawns the 3 head roles with global settings + presence stamp (kobo-299)", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    // 3-role head cell: lead + conductor + reviewer, comm opt-in
    expect(head).toContain("@role \"🎼 conductor\"");
    expect(head).toContain("@role \"🔎 reviewer\"");
    expect(head).toContain("@role \"👤 lead\"");
    // reviewer is the Stop-hook worker (deadlock-critical global settings path, kobo-91/94)
    expect(head).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
    expect(head).not.toContain("--settings .claude/crew-worker-settings.json");
    // reviewer writes to ψ/active/head/ — CREW_STATE_DIR must follow (kobo-95)
    expect(head).toContain("CREW_STATE_DIR=ψ/active/head");
    // presence scoping (kobo-267)
    expect(head).toContain("MAW_ROOM_COMPANY=");
    // review chain wired head-reviewer → lead (299 AC)
    expect(head).toContain("worker → crew reviewer → head reviewer → lead");
    // opus top tier (299 AC — model-tier full mapping is sibling kobo-300)
    expect(head).toContain("--model opus");
  });

  // kobo-300 — model tier: แพงบน-ถูกล่าง. head lead/conductor/reviewer = opus (judgment),
  // comm = sonnet (relay, high-volume low-judgment — same as warroom). worker .3 caught A
  // shipping comm=opus, off-spec; this pins comm sonnet so a regression can't slip back.
  test("head comm spawns with --model sonnet, not opus (kobo-300 tier fix)", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    // the comm spawn line uses sonnet
    const commSpawn = head.split("\n").find((l) => l.includes("comm-contract.md") && l.includes("--model"));
    expect(commSpawn).toBeDefined();
    expect(commSpawn).toContain("--model sonnet");
    expect(commSpawn).not.toContain("--model opus");
    // no comm pane left on opus anywhere (roster row + contract heading)
    expect(head).not.toContain("| comm       | %720    | opus");
    expect(head).not.toContain("comm 📡 · opt-in · opus");
    // full tier mapping table present (opus top · sonnet worker/scratchpad/comm)
    expect(head).toContain("model tier (spawn)");
    expect(head).toContain("worker×3 | **sonnet**");
  });

  // kobo-301 — the scratchpad is a read-only grounding role: it fetches sources into a
  // digest but must NOT mutate. The guard is structural (--disallowedTools hard-blocks the
  // write tools, and survives --dangerously-skip-permissions since disallow = exclude, not
  // prompt) + contract discipline for bash. Pin the structural guard so a spawn edit can't
  // silently drop it and hand scratchpad a write path.
  test("scratchpad spawns read-only — --disallowedTools blocks write tools (kobo-301)", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    const spawn = head.split("\n").find((l) => l.includes("scratchpad-contract.md") && l.includes("claude --model"));
    expect(spawn).toBeDefined();
    // sonnet tier (kobo-300) + autonomous (no blackhole) + structural no-write guard
    expect(spawn).toContain("--model sonnet");
    expect(spawn).toContain("--dangerously-skip-permissions");
    expect(spawn).toContain('--disallowedTools "Write Edit MultiEdit NotebookEdit"');
    // read-only role is explicit in the contract (defense-in-depth: bash discipline too)
    expect(head).toContain("read-only grounding");
    expect(head).toContain("no-write guard");
  });

  // kobo-304 — the worker cell (execution tier) IS the existing /crew, reused, not a new
  // spawn machinery. Pin that /head documents the nesting (crew → /crew) but does NOT
  // re-implement the /crew worker spawn — a future edit that copies /crew's split-window
  // spawn form into the worker-cell section would fork the kernel (drift). The only
  // worker-spawn split-window forms in this skill are for the HEAD panes (conductor,
  // reviewer, comm, scratchpad); the worker cell delegates to /crew.
  test("worker cell reuses /crew, not a re-implementation (kobo-304)", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    // the execution tier is documented as /crew reuse
    expect(head).toContain("Worker cell (execution tier · = /crew");
    // nesting is via invoking /crew (single kernel source), not a fresh spawn form
    expect(head).toContain("invoke `/crew`");
    // the worker-cell section names no new CREW_ROLE=worker spawn (that lives in /crew)
    const wcSection = head.slice(head.indexOf("## Worker cell"), head.indexOf("## lead-toilet-survive"));
    expect(wcSection).not.toContain("CREW_ROLE=worker");
    expect(wcSection).not.toContain("split-window"); // no re-implemented spawn machinery
  });
});

describe("crew-skills sync", () => {
  test("fresh install writes all items, hook is executable", () => {
    const home = freshHome();
    const result = syncCrewSkills({ home, assetsDir });

    expect(result.installed.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
    expect(result.skipped).toEqual([]);
    for (const item of SYNC_ITEMS) {
      expect(existsSync(join(home, ".claude", item.dest))).toBe(true);
    }
    const hookMode = statSync(join(home, ".claude/hooks/crew-worker-stop.sh")).mode & 0o111;
    expect(hookMode).not.toBe(0); // some exec bit set

    // installed content matches canonical assets
    const crew = readFileSync(join(home, ".claude/skills/crew/SKILL.md"), "utf8");
    expect(crew).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
  });

  test("second sync is idempotent (everything up-to-date)", () => {
    const home = freshHome();
    syncCrewSkills({ home, assetsDir });
    const again = syncCrewSkills({ home, assetsDir });
    expect(again.installed).toEqual([]);
    expect(again.skipped.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
  });

  test("drifted file is re-synced back to canonical", () => {
    const home = freshHome();
    syncCrewSkills({ home, assetsDir });
    const crewDest = join(home, ".claude/skills/crew/SKILL.md");
    writeFileSync(crewDest, "STALE COPY");

    const result = syncCrewSkills({ home, assetsDir });
    expect(result.installed).toContain("skills/crew/SKILL.md");
    expect(readFileSync(crewDest, "utf8")).not.toBe("STALE COPY");
  });

  test("--force rewrites even when unchanged", () => {
    const home = freshHome();
    syncCrewSkills({ home, assetsDir });
    const forced = syncCrewSkills({ home, assetsDir, force: true });
    expect(forced.installed.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
  });

  test("--dry-run reports changes but writes nothing", () => {
    const home = freshHome();
    const result = syncCrewSkills({ home, assetsDir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.installed.length).toBe(SYNC_ITEMS.length);
    expect(existsSync(join(home, ".claude/skills/crew/SKILL.md"))).toBe(false);
    expect(formatSyncResult(result)).toContain("would install");
  });

  test("wires the SessionStart seat-resume hook into the REPO settings, not global (scoped-both)", () => {
    const home = freshHome();
    const repoDir = freshHome(); // stands in for the oracle repo dir
    const result = syncCrewSkills({ home, assetsDir, repoDir });
    expect(result.seatHookWired).toBe(true);
    // asset script still installs globally (~/.claude/hooks) — unchanged
    expect(existsSync(join(home, ".claude/hooks/seat-resume.sh"))).toBe(true);
    // the wiring lands in the REPO's .claude/settings.json … (kobo-268: startup|resume|clear)
    const settings = JSON.parse(readFileSync(join(repoDir, ".claude/settings.json"), "utf8"));
    const entry = settings.hooks.SessionStart.find((e: any) => e.matcher === "startup|resume|clear");
    expect(entry.hooks[0].command).toBe("bash $HOME/.claude/hooks/seat-resume.sh");
    // … and NEVER the user's global ~/.claude/settings.json (worker.3 reject)
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
  });

  test("seat-resume hook wiring is idempotent (no duplicate entry)", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const again = syncCrewSkills({ home, assetsDir, repoDir });
    expect(again.seatHookWired).toBe(false);
    const settings = JSON.parse(readFileSync(join(repoDir, ".claude/settings.json"), "utf8"));
    const seats = settings.hooks.SessionStart.filter((e: any) => e.matcher === "startup|resume|clear");
    expect(seats.length).toBe(1);
  });

  // kobo-268 — a re-sync UPGRADES an old clear-only install to startup|resume|clear in place
  // (by matching the command), never leaving a stale clear-only entry or duplicating.
  test("seat-resume wiring upgrades an old clear-only matcher in place", () => {
    const home = freshHome();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ matcher: "clear", hooks: [{ type: "command", command: "bash $HOME/.claude/hooks/seat-resume.sh" }] }] },
    }));
    expect(ensureSeatResumeHook(claudeDir)).toBe(true); // upgraded
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    const entries = settings.hooks.SessionStart;
    expect(entries.length).toBe(1); // upgraded in place, not duplicated
    expect(entries[0].matcher).toBe("startup|resume|clear");
    expect(ensureSeatResumeHook(claudeDir)).toBe(false); // now current — no-op
  });

  test("seat-resume wiring preserves pre-existing settings + hooks (non-destructive)", () => {
    const home = freshHome();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
      model: "opus",
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "keep-me.sh" }] }] },
    }));
    ensureSeatResumeHook(claudeDir);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.SessionStart.some((e: any) => e.hooks[0].command === "keep-me.sh")).toBe(true);
    expect(settings.hooks.SessionStart.some((e: any) => e.matcher === "startup|resume|clear")).toBe(true); // kobo-268
  });
});
