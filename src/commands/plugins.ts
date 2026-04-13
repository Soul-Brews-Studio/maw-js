/**
 * maw plugins ls/info/install/remove
 * User-facing CLI for managing installed plugin packages.
 *
 * Subcommands:
 *   plugins / plugins ls      — table: name | version | surfaces | dir
 *   plugins info <name>       — full manifest + resolved paths, warn if wasm missing
 *   plugins install <path>    — validate via parseManifest, copy to ~/.maw/plugins/<name>/
 *   plugins remove <name>     — archive to /tmp/maw-plugin-<name>-<ts>/ (Nothing Deleted)
 *
 * MAW_PLUGIN_HOME env var overrides install destination (useful for tests).
 */

import { existsSync, mkdirSync, cpSync, renameSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { discoverPackages } from "../plugin/registry";
import { parseManifest } from "../plugin/manifest";
import type { LoadedPlugin } from "../plugin/types";

function getPluginHome(): string {
  return process.env.MAW_PLUGIN_HOME ?? join(homedir(), ".maw", "plugins");
}

type Flags = {
  _: string[];
  "--json"?: boolean;
  "--force"?: boolean;
  [key: string]: unknown;
};

/**
 * Entry point for `maw plugins <sub> [args] [flags]`.
 * @param discover - injectable for tests; defaults to discoverPackages
 */
export async function cmdPlugins(
  sub: string,
  _rawArgs: string[],
  flags: Flags,
  discover: () => LoadedPlugin[] = discoverPackages,
): Promise<void> {
  const name = flags._[0];
  switch (sub) {
    case "ls":
    case "list":
      return doLs(flags["--json"] ?? false, discover);
    case "info":
      if (!name) {
        console.error("usage: maw plugins info <name>");
        process.exit(1);
      }
      return doInfo(name, discover);
    case "install":
      if (!name) {
        console.error("usage: maw plugins install <path> [--force]");
        process.exit(1);
      }
      return doInstall(name, flags["--force"] ?? false);
    case "remove":
    case "uninstall":
    case "rm":
      if (!name) {
        console.error("usage: maw plugins remove <name>");
        process.exit(1);
      }
      return doRemove(name, discover);
    default:
      return doLs(flags["--json"] ?? false, discover);
  }
}

// ─── Subcommand implementations ────────────────────────────────────────────

function doLs(json: boolean, discover: () => LoadedPlugin[]): void {
  const plugins = discover();

  if (json) {
    console.log(
      JSON.stringify(
        plugins.map(p => ({
          name: p.manifest.name,
          version: p.manifest.version,
          surfaces: surfaces(p),
          dir: p.dir,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (plugins.length === 0) {
    console.log("no plugins installed");
    return;
  }

  const pluginHome = getPluginHome();
  const rows = plugins.map(p => {
    const source = p.dir.startsWith(pluginHome) ? "\x1b[32m●\x1b[0m installed"
      : p.dir.includes("src/commands/plugins") ? "\x1b[36m○\x1b[0m bundled"
      : "\x1b[33m○\x1b[0m legacy";
    return [
      p.manifest.name,
      p.manifest.version,
      source,
      surfaces(p),
    ];
  });
  printTable(["name", "version", "source", "surfaces"], rows);
}

function doInfo(name: string, discover: () => LoadedPlugin[]): void {
  const plugins = discover();
  const p = plugins.find(x => x.manifest.name === name);
  if (!p) {
    console.error(`plugin not found: ${name}`);
    process.exit(1);
  }

  const m = p.manifest;
  console.log(`\x1b[1m${m.name}\x1b[0m  ${m.version}`);
  if (m.description) console.log(`  desc:    ${m.description}`);
  if (m.author)      console.log(`  author:  ${m.author}`);
  console.log(`  sdk:     ${m.sdk}`);
  if (m.cli) {
    const help = m.cli.help ? `  — ${m.cli.help}` : "";
    console.log(`  cli:     ${m.cli.command}${help}`);
  }
  if (m.api) {
    console.log(`  api:     ${m.api.path}  [${m.api.methods.join(", ")}]`);
  }
  console.log(`  dir:     ${p.dir}`);

  const wasmExists = existsSync(p.wasmPath);
  const wasmMark = wasmExists ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ missing\x1b[0m";
  console.log(`  wasm:    ${p.wasmPath}  ${wasmMark}`);
  if (!wasmExists) {
    console.warn(`\x1b[33mwarn:\x1b[0m wasm file missing — plugin will not execute`);
  }
}

function doInstall(srcPath: string, force: boolean): void {
  let src: string;

  // GitHub URL → clone via ghq, then install from local path
  if (srcPath.startsWith("http") || srcPath.startsWith("github.com/")) {
    const url = srcPath.startsWith("http") ? srcPath : `https://${srcPath}`;
    console.log(`\x1b[36m⚡\x1b[0m cloning ${url}...`);
    try {
      execSync(`ghq get -u "${url}"`, { stdio: "pipe" });
    } catch {
      console.error(`failed to clone: ${url}`);
      process.exit(1);
    }
    const ghqRoot = execSync("ghq root", { encoding: "utf-8" }).trim();
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

function doRemove(name: string, discover: () => LoadedPlugin[]): void {
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function archiveToTmp(name: string, dir: string): void {
  const dest = `/tmp/maw-plugin-${name}-${Date.now()}`;
  renameSync(dir, dest);
}

function surfaces(p: LoadedPlugin): string {
  const parts: string[] = [];
  if (p.manifest.cli) parts.push(`cli:${p.manifest.cli.command}`);
  if (p.manifest.api) parts.push(`api:${p.manifest.api.path}`);
  return parts.join(", ") || "—";
}

function shortenHome(dir: string): string {
  const home = homedir();
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)),
  );
  const sep = widths.map(w => "─".repeat(w)).join("  ");
  const fmt = (row: string[]) =>
    row.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  console.log(sep);
  for (const row of rows) console.log(fmt(row));
}
