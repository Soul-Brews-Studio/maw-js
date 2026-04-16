/**
 * maw ui install / maw ui status
 *
 * install: downloads + extracts a pre-built maw-ui dist from a GitHub Release.
 *          Uses `gh release download` so existing gh auth is reused.
 *
 * status:  reports whether a dist is installed and how many entries it has.
 *
 * After install, `maw serve` automatically serves the UI alongside the API on
 * port 3456.
 *
 * NOTE: the maw-ui repo must have a release workflow that publishes dist.tar.gz
 *       as a release asset. That workflow lives in Soul-Brews-Studio/maw-ui,
 *       not here.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

const REPO = "Soul-Brews-Studio/maw-ui";
const DIST_DIR = join(homedir(), ".maw", "ui", "dist");

/**
 * Pure helper — returns the `gh` CLI args for downloading a release asset.
 * Extracted so tests can verify the command construction without mocking
 * spawnSync or touching the filesystem.
 */
export function buildGhReleaseArgs(repo: string, ref: string, dir: string): string[] {
  return ["release", "download", ref, "-R", repo, "--pattern", "dist.tar.gz", "--dir", dir];
}

export async function cmdUiInstall(version?: string): Promise<void> {
  const ref = version ?? "latest";

  process.stdout.write(`⚡ downloading maw-ui ${ref} from ${REPO}...\n`);

  const tmpDir = mkdtempSync(join(tmpdir(), "maw-ui-"));
  try {
    const dl = spawnSync("gh", buildGhReleaseArgs(REPO, ref, tmpDir), { encoding: "utf-8" });

    if (dl.status !== 0) {
      console.error(`✗ gh release download failed:\n${dl.stderr}`);
      console.error(`  → ensure: gh auth status, and a release with dist.tar.gz asset exists`);
      console.error(`  → TODO: maw-ui repo needs a release workflow that publishes dist.tar.gz`);
      process.exit(1);
    }

    const tarPath = join(tmpDir, "dist.tar.gz");

    // Wipe + recreate target so no stale files remain
    rmSync(DIST_DIR, { recursive: true, force: true });
    mkdirSync(DIST_DIR, { recursive: true });

    const ext = spawnSync("tar", ["-xzf", tarPath, "-C", DIST_DIR, "--strip-components=1"], {
      encoding: "utf-8",
    });
    if (ext.status !== 0) {
      console.error(`✗ tar extraction failed:\n${ext.stderr}`);
      process.exit(1);
    }

    const files = readdirSync(DIST_DIR);
    if (files.length === 0) {
      console.error(`✗ no files extracted to ${DIST_DIR}`);
      process.exit(1);
    }

    console.log(`✓ maw-ui ${ref} installed → ${DIST_DIR} (${files.length} top-level entries)`);
    console.log(`  → restart maw server to serve the new UI: pm2 restart maw OR maw serve`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function cmdUiStatus(): Promise<void> {
  if (!existsSync(DIST_DIR)) {
    console.log(`✗ maw-ui not installed`);
    console.log(`  → run: maw ui install`);
    return;
  }

  const files = readdirSync(DIST_DIR);
  let version = "unknown";
  try {
    const indexHtml = readFileSync(join(DIST_DIR, "index.html"), "utf-8");
    const m = indexHtml.match(/data-maw-ui-version="([^"]+)"/);
    if (m) version = m[1];
  } catch {
    /* ignore — index.html may not carry version metadata */
  }

  const versionStr = version === "unknown" ? "(version unknown)" : `v${version}`;
  console.log(`✓ maw-ui ${versionStr} at ${DIST_DIR}`);
  console.log(`  ${files.length} top-level entries`);
}
