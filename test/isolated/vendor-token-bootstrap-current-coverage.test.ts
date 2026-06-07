import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

const { bootstrapPluginsLock } = await import("../../src/vendor/mpr-plugins/init/bootstrap-plugins-lock.ts?vendor-token-bootstrap-current-coverage");
const { LOCK_SCHEMA } = await import("../../src/vendor/mpr-plugins/init/internal/plugin-lock.ts?vendor-token-bootstrap-current-coverage");
const { cmdCurrent } = await import("../../src/vendor/mpr-plugins/token/current.ts?vendor-token-bootstrap-current-coverage");

let tmp = "";
let originalLock: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "maw-vendor-token-bootstrap-"));
  originalLock = process.env.MAW_PLUGINS_LOCK;
  process.env.MAW_PLUGINS_LOCK = join(tmp, "nested", "plugins.lock");
});

afterEach(() => {
  if (originalLock === undefined) delete process.env.MAW_PLUGINS_LOCK;
  else process.env.MAW_PLUGINS_LOCK = originalLock;
  rmSync(tmp, { recursive: true, force: true });
});

describe("vendor bootstrap plugin lock", () => {
  test("creates a valid empty lock once and never overwrites an existing lock", () => {
    const first = bootstrapPluginsLock();
    expect(first.created).toBe(true);
    expect(first.path).toBe(process.env.MAW_PLUGINS_LOCK!);
    const parsed = JSON.parse(readFileSync(first.path, "utf-8"));
    expect(parsed.schema).toBe(LOCK_SCHEMA);
    expect(parsed.plugins).toEqual({});

    writeFileSync(first.path, "sentinel");
    const second = bootstrapPluginsLock();
    expect(second).toEqual({ created: false, path: first.path });
    expect(readFileSync(first.path, "utf-8")).toBe("sentinel");
    expect(existsSync(dirname(first.path))).toBe(true);
  });
});

describe("vendor token current", () => {
  test("returns null for missing, unreadable, or unrecognised .envrc and detects named tokens", () => {
    expect(cmdCurrent(tmp)).toBeNull();

    const envrc = join(tmp, ".envrc");
    writeFileSync(envrc, "export OTHER=value\n");
    expect(cmdCurrent(tmp)).toBeNull();

    writeFileSync(envrc, 'export CLAUDE_CODE_OAUTH_TOKEN="$(pass show claude/token-work)"\n');
    expect(cmdCurrent(tmp)).toBe("work");

    rmSync(envrc, { force: true });
    // Directory at .envrc makes readFileSync throw; cmdCurrent must stay silent.
    // lgtm[js/path-injection] — test temp path only.
    mkdirSync(envrc);
    expect(cmdCurrent(tmp)).toBeNull();
  });
});
