/**
 * plugins seam: doInstall + doRemove implementations.
 */

import type { LoadedPlugin } from "../../plugin/types";
import { existsSync, mkdirSync, cpSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { parseManifest } from "../../plugin/manifest";
import { archiveToTmp } from "./plugins-ui";
import { mawDataPath } from "../../core/xdg";
import { UserError } from "../../core/util/user-error";
import { symlinkDirSync } from "../../core/util/symlink-dir";

/** Allowlist: only http/https URLs permitted as plugin sources */
const URL_SCHEME_RE = /^https?:\/\//;

export type PluginInstallOptions = {
  /** Install into the cwd-local .maw/plugins tree instead of the global plugin home. */
  local?: boolean;
  /** Symlink the source directory into place for development instead of copying it. */
  symlink?: boolean;
};

function getPluginHome(options: PluginInstallOptions = {}): string {
  if (options.local) return join(process.cwd(), ".maw", "plugins");
  return process.env.MAW_PLUGIN_HOME ?? mawDataPath("plugins");
}

export async function doInstall(
  srcPath: string,
  force: boolean,
  options: PluginInstallOptions = {},
): Promise<void> {
  let src: string;

  // GitHub URL → clone via ghq, then install from local path
  if (srcPath.startsWith("http") || srcPath.startsWith("github.com/")) {
    const url = srcPath.startsWith("http") ? srcPath : `https://${srcPath}`;
    if (!URL_SCHEME_RE.test(url)) {
      throw new UserError(`invalid URL scheme: ${url}`);
    }
    console.log(`\x1b[36m⚡\x1b[0m cloning ${url}...`);
    try {
      const proc = Bun.spawn(["ghq", "get", "-u", url], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`ghq exited ${code}`);
    } catch {
      throw new UserError(`failed to clone: ${url}`);
    }
    const rootProc = Bun.spawn(["ghq", "root"], { stdout: "pipe", stderr: "pipe" });
    await rootProc.exited;
    const ghqRoot = (await new Response(rootProc.stdout).text()).trim();
    const repoPath = url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    src = join(ghqRoot, repoPath);
    if (!existsSync(src)) throw new UserError(`cloned but not found: ${src}`);

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
    throw new UserError(`path not found: ${src}`);
  }

  let manifestJson: string;
  try {
    manifestJson = readFileSync(join(src, "plugin.json"), "utf8");
  } catch {
    throw new UserError(`no plugin.json in: ${src}`);
  }

  let manifest: ReturnType<typeof parseManifest>;
  try {
    manifest = parseManifest(manifestJson, src);
  } catch (err: any) {
    throw new UserError(`invalid plugin: ${err.message}`);
  }

  const pluginHome = getPluginHome(options);
  const dest = join(pluginHome, manifest.name);
  if (existsSync(dest)) {
    if (!force) {
      throw new UserError(`plugin '${manifest.name}' already installed — use --force to overwrite`);
    }
    // Archive existing before overwrite (Nothing Deleted)
    archiveToTmp(manifest.name, dest);
  }

  mkdirSync(pluginHome, { recursive: true });
  if (options.symlink) {
    symlinkDirSync(resolve(src), dest);
  } else {
    cpSync(src, dest, { recursive: true });
  }
  console.log(
    `\x1b[32m✓\x1b[0m installed ${manifest.name}@${manifest.version} → ${dest}`,
  );
}

export function doRemove(name: string, discover: () => LoadedPlugin[]): void {
  const plugins = discover();
  const p = plugins.find(x => x.manifest.name === name);
  if (!p) throw new UserError(`plugin not found: ${name}`);
  archiveToTmp(name, p.dir);
  console.log(
    `\x1b[32m✓\x1b[0m removed ${name} → archived to ${tmpdir()}/maw-plugin-${name}-*`,
  );
}
