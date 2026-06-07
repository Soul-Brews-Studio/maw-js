import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";

const repo = join(import.meta.dir, "../..");
const installer = readFileSync(join(repo, "scripts/install-git-hooks.sh"), "utf-8");
const hook = readFileSync(join(repo, "scripts/hooks/post-commit"), "utf-8");
const envExample = readFileSync(join(repo, "scripts/hooks/maw-hooks.env.example"), "utf-8");

describe("local git hook installer (#1451)", () => {
  test("installer and post-commit template are executable", () => {
    expect(statSync(join(repo, "scripts/install-git-hooks.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(repo, "scripts/hooks/post-commit")).mode & 0o111).not.toBe(0);
  });

  test("post-commit delegates to package build script, not a duplicated bun build command", () => {
    expect(hook).toContain("bun run build");
    expect(hook).not.toContain("bun build src/cli.ts");
    expect(hook).toContain("--external @eclipse-zenoh/zenoh-ts");
  });

  test("installer copies the tracked hook into .git/hooks/post-commit", () => {
    expect(installer).toContain("scripts/hooks/post-commit");
    expect(installer).toContain(".git/hooks/post-commit");
    expect(installer).toContain("cmp -s");
    expect(installer).toContain("backup-");
  });

  test("env example exposes deploy knobs used by the hook", () => {
    for (const key of ["MAW_HOOK_BUILD", "MAW_HOOK_DEPLOY", "MAW_HOOK_PM2", "MAW_HOOK_MIRROR", "MAW_HOOK_MIRROR_BRANCH"]) {
      expect(envExample).toContain(key);
      expect(hook).toContain(key);
    }
  });
});
