import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { SYNC_ITEMS, formatSyncResult, syncCrewSkills } from "../../src/vendor/mpr-plugins/crew-skills/sync.ts?plugin-crew-skills-standalone";

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

  test("crew skill spawns workers with the $HOME-absolute settings path", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(skill).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
    expect(skill).not.toContain("--settings .claude/crew-worker-settings.json");
  });

  // warroom's coord reads its own contract and spawns workers too — same global
  // path requirement (kobo-94): a bare/relative --settings there re-opens the
  // deadlock once local .claude/ copies are removed.
  test("warroom skill has no cwd-relative crew-worker-settings reference", () => {
    const skill = readFileSync(join(assetsDir, "skills/warroom/SKILL.md"), "utf8");
    expect(skill).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
    expect(skill).not.toContain("--settings .claude/crew-worker-settings.json");
    // no bare relative "crew-worker-settings.json" (only the $HOME-absolute form)
    for (const m of skill.matchAll(/crew-worker-settings\.json/g)) {
      const before = skill.slice(Math.max(0, m.index! - 20), m.index!);
      expect(before).toContain("$HOME/.claude/");
    }
  });

  // kobo-95: warroom workers write to ψ/active/warroom/ — the hook state hint
  // must follow via CREW_STATE_DIR, or a coord that trusts the hint reads the
  // wrong path. Both halves must ship together or the parametrize is a no-op.
  test("warroom spawn sets CREW_STATE_DIR and hook honors it", () => {
    const warroom = readFileSync(join(assetsDir, "skills/warroom/SKILL.md"), "utf8");
    expect(warroom).toContain("CREW_STATE_DIR=ψ/active/warroom");

    const hook = readFileSync(join(assetsDir, "hooks/crew-worker-stop.sh"), "utf8");
    expect(hook).toContain("${CREW_STATE_DIR:-ψ/active/crew}/$CREW_ROLE.md");
    // no lingering hardcoded crew path in the hint
    expect(hook).not.toContain("state: ψ/active/crew/$CREW_ROLE.md");
  });

  // kobo-150: crew SKILL forwards CREW_STATE_DIR (default ψ/active/crew, warroom
  // overrides to ψ/active/warroom) so the same spawn form works under บานพับ.
  test("crew skill forwards CREW_STATE_DIR with the default state dir", () => {
    const crew = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(crew).toContain("${CREW_STATE_DIR:-ψ/active/crew}");
    expect(crew).toContain("CREW_STATE_DIR=");
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
});
