import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, symlinkSync, readlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { installFromDir } from "../../src/commands/plugins/plugin/install-handlers";

// Regression test for #403 — `maw plugin install --link` silently
// overwrote existing plugin symlinks. Fix: refuse unless --force.
//
// MEYD-605 surfaced the multi-agent danger: one agent's --link can break
// another agent's working plugin if names collide. Refuse-then-override
// matches the same pattern as Bug F's fleet-exclusion.

let testRoot: string;
let pluginsRoot: string;
let originalEnv: string | undefined;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "maw-bug403-"));
  pluginsRoot = join(testRoot, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  originalEnv = process.env.MAW_PLUGINS_DIR;
  process.env.MAW_PLUGINS_DIR = pluginsRoot;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.MAW_PLUGINS_DIR;
  else process.env.MAW_PLUGINS_DIR = originalEnv;
  try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

function createPluginSrc(name: string, version = "1.0.0"): string {
  const dir = join(testRoot, "src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    name, version, sdk: "^1.0.0", entry: "./index.ts", description: "test",
  }));
  writeFileSync(join(dir, "index.ts"), "export default async function() { return { ok: true }; }\n");
  return dir;
}

describe("installFromDir — #403 refuse silent overwrite", () => {
  test("first install succeeds (no existing)", async () => {
    const src = createPluginSrc("foo-plugin");
    await installFromDir(src);
    expect(existsSync(join(pluginsRoot, "foo-plugin"))).toBe(true);
    expect(readlinkSync(join(pluginsRoot, "foo-plugin"))).toBe(src);
  });

  test("second install of same name → THROWS (refusing-to-overwrite)", async () => {
    const src1 = createPluginSrc("collide");
    await installFromDir(src1);
    const src2 = join(testRoot, "src", "collide-v2");
    mkdirSync(src2, { recursive: true });
    writeFileSync(join(src2, "plugin.json"), JSON.stringify({
      name: "collide", version: "2.0.0", sdk: "^1.0.0", entry: "./index.ts",
    }));
    writeFileSync(join(src2, "index.ts"), "export default function(){}\n");

    await expect(installFromDir(src2)).rejects.toThrow(/refusing to overwrite plugin 'collide'/);
    // Original symlink still intact
    expect(readlinkSync(join(pluginsRoot, "collide"))).toBe(src1);
  });

  test("error message surfaces existing target + incoming source", async () => {
    const src1 = createPluginSrc("show-info");
    await installFromDir(src1);
    const src2 = join(testRoot, "src", "show-info-v2");
    mkdirSync(src2, { recursive: true });
    writeFileSync(join(src2, "plugin.json"), JSON.stringify({
      name: "show-info", version: "2.0.0", sdk: "^1.0.0", entry: "./index.ts",
    }));
    writeFileSync(join(src2, "index.ts"), "export default function(){}\n");

    try {
      await installFromDir(src2);
      throw new Error("should have refused");
    } catch (e: any) {
      expect(e.message).toContain("existing:");
      expect(e.message).toContain(src1);  // existing target shown
      expect(e.message).toContain("incoming:");
      expect(e.message).toContain(src2);  // incoming source shown
      expect(e.message).toContain("--force");
    }
  });

  test("--force allows overwrite", async () => {
    const src1 = createPluginSrc("force-me");
    await installFromDir(src1);
    const src2 = join(testRoot, "src", "force-me-v2");
    mkdirSync(src2, { recursive: true });
    writeFileSync(join(src2, "plugin.json"), JSON.stringify({
      name: "force-me", version: "2.0.0", sdk: "^1.0.0", entry: "./index.ts",
    }));
    writeFileSync(join(src2, "index.ts"), "export default function(){}\n");

    await installFromDir(src2, { force: true });
    expect(readlinkSync(join(pluginsRoot, "force-me"))).toBe(src2);
  });

  test("force=false explicitly is the same as omitted (defaults safe)", async () => {
    const src1 = createPluginSrc("default-safe");
    await installFromDir(src1, { force: false });
    expect(existsSync(join(pluginsRoot, "default-safe"))).toBe(true);

    const src2 = join(testRoot, "src", "default-safe-v2");
    mkdirSync(src2, { recursive: true });
    writeFileSync(join(src2, "plugin.json"), JSON.stringify({
      name: "default-safe", version: "2.0.0", sdk: "^1.0.0", entry: "./index.ts",
    }));
    writeFileSync(join(src2, "index.ts"), "export default function(){}\n");

    await expect(installFromDir(src2, { force: false })).rejects.toThrow(/refusing/);
  });
});
