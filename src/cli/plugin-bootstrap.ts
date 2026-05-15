import { mkdirSync, existsSync, readdirSync, symlinkSync, cpSync, readFileSync, lstatSync, unlinkSync } from "fs";
import { join } from "path";

/** Allowlist: only http/https URLs may be used as plugin sources */
const URL_SCHEME_RE = /^https?:\/\//;

function isPluginDir(dir: string): boolean {
  return existsSync(join(dir, "plugin.json")) || existsSync(join(dir, "index.ts"));
}

function linkBundledPlugins(pluginDir: string, bundled: string): number {
  if (!existsSync(bundled)) return 0;
  let linked = 0;
  for (const d of readdirSync(bundled)) {
    const src = join(bundled, d);
    const dest = join(pluginDir, d);
    if (!isPluginDir(src)) continue;
    if (existsSync(dest)) continue; // already linked / user dir / valid symlink
    symlinkSync(src, dest);
    linked++;
  }
  return linked;
}

function healOrPruneBrokenSymlinks(pluginDir: string, bundledRoots: string[]): { healed: number; pruned: number } {
  let healed = 0;
  let pruned = 0;
  for (const entry of readdirSync(pluginDir)) {
    const p = join(pluginDir, entry);
    try {
      if (!lstatSync(p).isSymbolicLink() || existsSync(p)) continue;
      const replacement = bundledRoots
        .map((root) => join(root, entry))
        .find((candidate) => existsSync(candidate) && isPluginDir(candidate));
      unlinkSync(p);
      if (replacement) {
        symlinkSync(replacement, p);
        healed++;
      } else {
        pruned++;
      }
    } catch {}
  }
  return { healed, pruned };
}

/**
 * Auto-bootstrap plugins into pluginDir.
 *
 * Bundled-plugin symlinks are idempotent — walked on every boot so newly
 * added bundled plugins (e.g. introduced by an update) get linked into
 * existing installs. Existing destinations (symlinks or user dirs) are
 * never overwritten.
 *
 * The pluginSources URL fetch path is preserved as first-install only:
 * it makes network calls and has a different cost profile, so it still
 * runs only when pluginDir is empty.
 *
 * Bug: #817 — bootstrap-on-empty caused new bundled plugins to be
 * silently invisible on every existing host until a manual symlink.
 *
 * @param pluginDir  resolved ~/.maw/plugins/ path
 * @param srcDir     resolved src/ directory (pass import.meta.dir from cli.ts)
 */
export async function runBootstrap(pluginDir: string, srcDir: string): Promise<void> {
  mkdirSync(pluginDir, { recursive: true });

  // 0. #1015 — prune broken symlinks before anything else. After an update
  //    removes bundled plugins from src/commands/plugins/, their old symlinks
  //    in ~/.maw/plugins/ become dangling. readdirSync still lists them, but
  //    existsSync returns false (target gone). The plugin loader silently
  //    skips them, so the user sees "unknown command" with no explanation.
  const bundledRoots = [
    join(srcDir, "commands", "plugins"),
    join(srcDir, "vendor", "mpr-plugins"),
  ];
  const { pruned } = healOrPruneBrokenSymlinks(pluginDir, bundledRoots);
  if (pruned > 0) {
    console.warn(`[maw] removed ${pruned} broken plugin symlink${pruned === 1 ? "" : "s"} from ${pluginDir}`);
  }

  const wasEmpty = readdirSync(pluginDir).length === 0;

  // 1. Symlink any bundled plugin missing from pluginDir — IDEMPOTENT,
  //    runs every boot. Cheap (fs stat + symlink), no network.
  linkBundledPlugins(pluginDir, bundledRoots[0]);

  // #1339 — fresh installs must also get the maw-plugin-registry command
  // surface (`wake`, `attach`, `done`, `send-enter`, ...). The vendored copy is
  // source-only and intentionally uses the same pluginDir symlink mechanism as
  // in-tree plugins so user-installed plugins keep precedence.
  linkBundledPlugins(pluginDir, bundledRoots[1]);

  // 2. Install from pluginSources URLs — first-install only (network calls,
  //    should not retry every boot).
  if (wasEmpty) {
    try {
      const { loadConfig } = await import("../config");
      const config = loadConfig();
      const sources: string[] = config.pluginSources ?? [];
      for (const url of sources) {
        try {
          if (!URL_SCHEME_RE.test(url)) {
            console.warn(`[maw] skipping pluginSource with invalid scheme: ${url}`);
            continue;
          }
          const ghqProc = Bun.spawn(["ghq", "get", "-u", url], { stdout: "pipe", stderr: "pipe" });
          await ghqProc.exited;
          const rootProc = Bun.spawn(["ghq", "root"], { stdout: "pipe", stderr: "pipe" });
          await rootProc.exited;
          const ghqRoot = (await new Response(rootProc.stdout).text()).trim();
          const repoPath = url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
          const src = join(ghqRoot, repoPath);
          const pkgDir = join(src, "packages");
          if (existsSync(pkgDir)) {
            for (const pkg of readdirSync(pkgDir)) {
              if (existsSync(join(pkgDir, pkg, "plugin.json"))) {
                const dest = join(pluginDir, pkg);
                if (!existsSync(dest)) {
                  cpSync(join(pkgDir, pkg), dest, { recursive: true });
                }
              }
            }
          } else if (existsSync(join(src, "plugin.json"))) {
            const manifest = JSON.parse(readFileSync(join(src, "plugin.json"), "utf-8"));
            const dest = join(pluginDir, manifest.name);
            if (!existsSync(dest)) cpSync(src, dest, { recursive: true });
          }
        } catch {}
      }
    } catch {}

    console.log(`[maw] bootstrapped ${readdirSync(pluginDir).length} plugins → ${pluginDir}`);
  }
}
