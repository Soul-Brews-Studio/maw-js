/**
 * maw ui --install — download and extract a pre-built maw-ui dist.
 *
 * Downloads the latest (or specified) release from Soul-Brews-Studio/maw-ui,
 * extracts to ~/.maw/ui/dist/, and confirms. After install, `maw serve`
 * automatically serves the UI alongside the API on port 3456.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const UI_DIR = join(homedir(), ".maw", "ui");
const DIST_DIR = join(UI_DIR, "dist");
const REPO = "Soul-Brews-Studio/maw-ui";

export async function cmdUiInstall(version?: string): Promise<void> {
  // Resolve version
  const tag = version || getLatestTag();
  if (!tag) {
    console.error("\x1b[31m✗\x1b[0m Could not determine latest release version");
    process.exit(1);
  }

  console.log(`\x1b[36m👁 maw ui --install ${tag}\x1b[0m`);
  console.log(`  Downloading maw-ui dist from ${REPO}@${tag}...`);

  // Create dir
  mkdirSync(UI_DIR, { recursive: true });

  // Download tarball from GitHub release
  const tarUrl = `https://github.com/${REPO}/releases/download/${tag}/maw-ui-dist.tar.gz`;
  const tarPath = join(UI_DIR, "maw-ui-dist.tar.gz");

  try {
    execSync(`curl -fsSL -o "${tarPath}" "${tarUrl}"`, { stdio: "inherit" });
  } catch {
    // Fallback: try downloading the source and building
    console.log(`  No release tarball found at ${tag}. Trying artifact download...`);
    console.error(`\x1b[31m✗\x1b[0m No pre-built dist available for ${tag}`);
    console.error(`  To create one: cd maw-ui && npm run build && tar -czf maw-ui-dist.tar.gz -C dist .`);
    console.error(`  Then: gh release create ${tag} maw-ui-dist.tar.gz --repo ${REPO}`);
    process.exit(1);
  }

  // Extract — clear old dist first
  if (existsSync(DIST_DIR)) {
    rmSync(DIST_DIR, { recursive: true });
  }
  mkdirSync(DIST_DIR, { recursive: true });

  execSync(`tar -xzf "${tarPath}" -C "${DIST_DIR}"`, { stdio: "inherit" });

  // Clean up tarball
  rmSync(tarPath);

  // Verify
  const indexExists = existsSync(join(DIST_DIR, "index.html"));
  const fedExists = existsSync(join(DIST_DIR, "federation_2d.html"));

  if (!indexExists) {
    console.error(`\x1b[31m✗\x1b[0m Extraction failed — no index.html in ${DIST_DIR}`);
    process.exit(1);
  }

  console.log(`  \x1b[32m✓\x1b[0m Extracted to ${DIST_DIR}`);
  console.log(`  \x1b[32m✓\x1b[0m index.html: ${indexExists ? "found" : "MISSING"}`);
  console.log(`  \x1b[32m✓\x1b[0m federation_2d.html: ${fedExists ? "found" : "not found (optional)"}`);
  console.log(`\n  maw-js will serve this UI at http://localhost:3456/ on next start.`);
  console.log(`  Update with: maw ui --install [version]`);
  console.log(`  Remove with: rm -rf ${DIST_DIR}`);
}

function getLatestTag(): string | null {
  try {
    const result = execSync(
      `curl -s https://api.github.com/repos/${REPO}/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4`,
      { encoding: "utf-8" },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}
