/**
 * plugins seam: doInstall + doRemove implementations.
 */

import type { LoadedPlugin } from "../../plugin/types";
import { existsSync, mkdirSync, cpSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { parseManifest } from "../../plugin/manifest";
import { archiveToTmp } from "./plugins-ui";

/** Allowlist: only http/https URLs permitted as plugin sources */
const URL_SCHEME_RE = /^https?:\/\//;

function getPluginHome(): string {
  return process.env.MAW_PLUGIN_HOME ?? join(require("os").homedir(), ".maw", "plugins");
}

export async function doInstall(srcPath: string, force: boolean): Promise<void> {
  let src: string;

  // GitHub URL → clone via ghq, then install from local path
  if (srcPath.startsWith("http") || srcPath.startsWith("github.com/")) {
    const url = srcPath.startsWith("http") ? srcPath : `https://${srcPath}`;
    if (!URL_SCHEME_RE.test(url)) {
      console.error(`invalid URL scheme: ${url}`);
      process.exit(1);
    }
    console.log(`\x1b[36m⚡\x1b[0m cloning ${url}...`);
    try {
      const proc = Bun.spawn(["ghq", "get", "-u", url], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`ghq exited ${code}`);
    } catch {
      console.error(`failed to clone: ${url}`);
      process.exit(1);
    }
    const rootProc = Bun.spawn(["ghq", "root"], { stdout: "pipe", stderr: "pipe" });
    await rootProc.exited;
    const ghqRoot = (await new Response(rootProc.stdout).text()).trim();
    const repoPath = url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    src = join(ghqRoot, repoPath);
    if (!existsSync(src)) { console.error(`cloned but not found: ${src}`); process.exit(1); }

    // Monorepo? List available plugins
    const pkgDir = join(src, "packages");
    if (existsSync(pkgDir)) {
      const pkgs = require("fs").readdirSync(pkgDir)
        .filter((d: string) => existsSync(join(pkgDir, d, "plugin.json")));
      if (pkgs.length > 0) {
        console.log(`\n  Found ${pkgs.length} plugins:\n`);
        for (const pkg of pkgs) {
          try {
            const m = JSON.parse(readFileSync(join(pkgDir, pkg, "plugin.json"), "utf-8"));
            console.log(`    ${pkg.padEnd(25)} ${m.name} v${m.version}`);
          } catch { console.log(`    ${pkg}`); }
        }
        console.log(`\n  Install: maw plugin install ${pkgDir}/<name>`);
        return;
      }
    }
  } else {
    src = resolve(srcPath);
  }

  if (!existsSync(src)) {
    console.error(`path not found: ${src}`);
    process.exit(1);
  }

  let manifestJson: string;
  try {
    manifestJson = readFileSync(join(src, "plugin.json"), "utf8");
  } catch {
    console.error(`no plugin.json in: ${src}`);
    process.exit(1);
  }

  let manifest: ReturnType<typeof parseManifest>;
  try {
    manifest = parseManifest(manifestJson, src);
  } catch (err: any) {
    console.error(`invalid plugin: ${err.message}`);
    process.exit(1);
  }

  const dest = join(getPluginHome(), manifest.name);
  if (existsSync(dest)) {
    if (!force) {
      console.error(
        `plugin '${manifest.name}' already installed — use --force to overwrite`,
      );
      process.exit(1);
    }
    // Archive existing before overwrite (Nothing Deleted)
    archiveToTmp(manifest.name, dest);
  }

  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(
    `\x1b[32m✓\x1b[0m installed ${manifest.name}@${manifest.version} → ${dest}`,
  );
}

export function doRemove(name: string, discover: () => LoadedPlugin[]): void {
  const plugins = discover();
  const p = plugins.find(x => x.manifest.name === name);
  if (!p) {
    console.error(`plugin not found: ${name}`);
    process.exit(1);
  }
  archiveToTmp(name, p.dir);
  console.log(
    `\x1b[32m✓\x1b[0m removed ${name} → archived to /tmp/maw-plugin-${name}-*`,
  );
}
