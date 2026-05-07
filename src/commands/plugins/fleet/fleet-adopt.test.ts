/**
 * fleet-adopt — adoptByPath() helper exposed for #1147 (bud lifecycle).
 *
 * The helper writes a `<NN>-<stem>.json` into FLEET_DIR. FLEET_DIR is captured
 * at module-load time from MAW_CONFIG_DIR (src/core/paths.ts), so we set the
 * env var BEFORE the dynamic import so the module sees the temp dir.
 *
 * org/repo derivation falls back to `git remote get-url origin` when the path
 * isn't under `ghq root` — that's the seam we exercise here (real `git init`
 * + remote add in a tmpdir).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "maw-fleet-adopt-"));
const tmpConfigDir = join(tmpRoot, "config");
const fleetDir = join(tmpConfigDir, "fleet");
mkdirSync(fleetDir, { recursive: true });
process.env.MAW_CONFIG_DIR = tmpConfigDir;

// Import AFTER env override so FLEET_DIR resolves to our tmpdir.
const adoptMod = await import("./fleet-adopt");
const { adoptByPath } = adoptMod;

function makeRepo(name: string, claudeMdLine1: string): string {
  const repoPath = join(tmpRoot, "repos", name);
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "CLAUDE.md"), `${claudeMdLine1}\n\nbody.\n`);
  // Real git repo with a fake origin remote so deriveOrgRepo's fallback works.
  execSync("git init -q", { cwd: repoPath });
  execSync(`git remote add origin git@github.com:Soul-Brews-Studio/${name}.git`, { cwd: repoPath });
  return repoPath;
}

function clearFleet(): void {
  for (const f of readdirSync(fleetDir)) rmSync(join(fleetDir, f), { force: true });
}

beforeEach(() => clearFleet());

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("adoptByPath — exposed helper for #1147", () => {
  test("import resolves through the package exports map shape", () => {
    // The helper must be a callable async function (the public contract).
    expect(typeof adoptByPath).toBe("function");
  });

  test("happy path: writes <NN>-<stem>.json with derived org/repo", async () => {
    const repo = makeRepo("foo-oracle", "# foo Oracle");

    const result = await adoptByPath(repo);

    expect(result.slot).toBe(1);
    expect(result.groupName).toBe("foo");
    expect(result.written).toBe(true);
    expect(result.configPath).toBe(join(fleetDir, "01-foo.json"));
    expect(existsSync(result.configPath)).toBe(true);

    const written = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(written).toMatchObject({
      name: "01-foo",
      windows: [{ name: "foo-oracle", repo: "Soul-Brews-Studio/foo-oracle" }],
      adopted_from: "ghq:Soul-Brews-Studio/foo-oracle",
    });
    expect(typeof written.adopted_at).toBe("string");
  });

  test("dry-run: returns config but writes nothing", async () => {
    const repo = makeRepo("bar-oracle", "# bar Oracle");

    const result = await adoptByPath(repo, { dryRun: true });

    expect(result.written).toBe(false);
    expect(result.slot).toBe(1);
    expect(existsSync(result.configPath)).toBe(false);
    expect(result.config.windows[0].repo).toBe("Soul-Brews-Studio/bar-oracle");
  });

  test("slot increments based on existing fleet entries", async () => {
    writeFileSync(join(fleetDir, "07-existing.json"), JSON.stringify({
      name: "07-existing",
      windows: [{ name: "existing-oracle", repo: "x/existing" }],
    }));
    const repo = makeRepo("baz-oracle", "# baz Oracle");

    const result = await adoptByPath(repo);

    expect(result.slot).toBe(8);
    expect(result.configPath).toBe(join(fleetDir, "08-baz.json"));
  });

  test("opts.as overrides the extracted stem", async () => {
    const repo = makeRepo("qux-oracle", "# qux Oracle");

    const result = await adoptByPath(repo, { as: "custom" });

    expect(result.groupName).toBe("custom");
    expect(result.configPath).toBe(join(fleetDir, "01-custom.json"));
  });

  test("missing CLAUDE.md → throws", async () => {
    const repoPath = join(tmpRoot, "repos", "no-claude");
    mkdirSync(repoPath, { recursive: true });

    let err: Error | undefined;
    try { await adoptByPath(repoPath); }
    catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/CLAUDE\.md not found/);
  });

  test("duplicate stem already in fleet → throws", async () => {
    const repo = makeRepo("dupe-oracle", "# dupe Oracle");
    await adoptByPath(repo);
    // Second adoption of same stem must fail.
    const repo2 = makeRepo("dupe-oracle-2", "# dupe Oracle");

    let err: Error | undefined;
    try { await adoptByPath(repo2); }
    catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/already exists in fleet/);
  });
});
