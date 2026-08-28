import { describe, test, expect } from "bun:test";
import { join } from "path";
import { generateClaudeSettings, type GenerateClaudeSettingsDeps } from "../src/vendor/mpr-plugins/bud/bud-init";

const HOME = "/home/bud";
const HOOK_SCRIPT = join(HOME, ".config/maw/hooks/status-reporter.sh");
const REPO = "/repos/new-oracle";
const SETTINGS = join(REPO, ".claude", "settings.json");

function harness(present: Set<string>) {
  const writes = new Map<string, string>();
  const mkdirs: string[] = [];
  const logs: string[] = [];
  const deps: GenerateClaudeSettingsDeps = {
    homeDir: HOME,
    existsSync: (p) => present.has(p),
    writeFileSync: (p, data) => { writes.set(p, data); },
    mkdirSync: (p) => { mkdirs.push(p); },
    logger: { log: (...args: unknown[]) => logs.push(args.map(String).join(" ")) },
  };
  return { deps, writes, mkdirs, logs };
}

describe("bud generateClaudeSettings — status-reporter hook guard", () => {
  test("skips settings.json when the status-reporter script is not installed", () => {
    const h = harness(new Set()); // nothing exists — script absent
    generateClaudeSettings(REPO, h.deps);

    expect(h.writes.has(SETTINGS)).toBe(false);
    expect(h.mkdirs).toEqual([]);
    expect(h.logs.join("\n")).toContain("skipped (status-reporter hook not installed");
    expect(h.logs.join("\n")).toContain(HOOK_SCRIPT);
  });

  test("scaffolds settings.json wiring both hooks when the script exists", () => {
    const h = harness(new Set([HOOK_SCRIPT])); // script installed, settings absent
    generateClaudeSettings(REPO, h.deps);

    expect(h.writes.has(SETTINGS)).toBe(true);
    const settings = JSON.parse(h.writes.get(SETTINGS)!);
    expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "Stop"]);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(`CLAUDE_HOOK_EVENT=SessionStart ${HOOK_SCRIPT}`);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`CLAUDE_HOOK_EVENT=Stop ${HOOK_SCRIPT}`);
    expect(h.mkdirs).toContain(join(REPO, ".claude"));
    expect(h.logs.join("\n")).toContain(".claude/settings.json + status hooks");
  });

  test("leaves an existing settings.json untouched", () => {
    const h = harness(new Set([SETTINGS, HOOK_SCRIPT])); // settings already there
    generateClaudeSettings(REPO, h.deps);

    expect(h.writes.size).toBe(0);
    expect(h.mkdirs).toEqual([]);
    expect(h.logs.join("\n")).toContain(".claude/settings.json exists");
  });
});
