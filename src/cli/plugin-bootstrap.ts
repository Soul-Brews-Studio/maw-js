import { mkdirSync, existsSync, readdirSync, symlinkSync, cpSync, readFileSync, lstatSync, unlinkSync, readlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { ensureMawJsResolvable } from "../plugin/ensure-maw-js-resolvable";

/** Allowlist: only http/https URLs may be used as plugin sources */
const URL_SCHEME_RE = /^https?:\/\//;

/** Expand a leading "~/" to the current user's home directory. */
function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * #1314 — Transient/worktree-path detector.
 *
 * A bundled-plugin path under `/tmp/` (or macOS's `/private/tmp/`) is almost
 * certainly a git worktree the user will delete — common in /parallel-ship
 * setups where each issue gets `git worktree add /tmp/maw-js-<N>`. Persisting
 * such a path to config OR migrating symlinks toward it leaves the next CLI
 * invocation pointing at a deleted directory, silently degrading `maw <verb>`
 * for all 18 bundled plugins.
 */
function isTransientPath(p: string): boolean {
  return /^(\/private)?\/tmp\//.test(p);
}

function isPluginDir(dir: string): boolean {
  return existsSync(join(dir, "plugin.json")) || existsSync(join(dir, "index.ts"));
}

/**
 * Resolve the absolute path to the bundled-plugins directory.
 *
 * Priority (#1186):
 *   1. `$MAW_BUNDLED_PLUGINS` — env override; escape hatch for tests and
 *      distributed binaries that ship plugins alongside the executable.
 *   2. `config.bundledPluginSource` — persisted by a prior source-mode boot
 *      so the compiled binary keeps finding plugins after the binary has
 *      replaced the bun-linked source path.
 *   3. `<srcDirHint>/commands/plugins` — works in source / `bun link` mode
 *      where `import.meta.dir` still resolves to the source tree.
 *
 * Returns the resolved path or null if none exist. Callers warn rather than
 * throw so an already-populated `pluginDir` continues to work.
 */
export async function resolveBundledPath(srcDirHint: string): Promise<string | null> {
  const envPath = process.env.MAW_BUNDLED_PLUGINS;
  if (envPath) {
    const expanded = expandHome(envPath);
    if (existsSync(expanded)) return expanded;
  }

  try {
    const { loadConfig } = await import("../config");
    const configured = loadConfig().bundledPluginSource;
    if (configured) {
      const expanded = expandHome(configured);
      // #1314 — skip a transient/worktree path (likely from a removed
      // worktree). Don't rewrite config here; the next stable
      // persistBundledPath call will overwrite the entry naturally.
      if (!isTransientPath(expanded) && existsSync(expanded)) return expanded;
    }
  } catch {}

  const fromSrc = join(srcDirHint, "commands", "plugins");
  if (existsSync(fromSrc)) return fromSrc;

  return null;
}

/**
 * Persist the resolved bundled-plugins path to config when it came from the
 * srcDir hint — that's the source / `bun link` boot recording its location
 * for the later compiled-binary boot. Skipped under `MAW_TEST_MODE=1` to
 * keep test runs from writing into the real config file.
 */
async function persistBundledPath(resolvedPath: string): Promise<void> {
  if (process.env.MAW_TEST_MODE === "1") return;
  // #1314 — never persist transient/worktree paths. `bun link maw-js` from
  // a `/tmp/` worktree (common in /parallel-ship setups) would otherwise
  // stamp the transient path into config; the next session can't find it
  // and silently degrades to "unknown command" for all 18 bundled plugins
  // once the worktree is removed.
  if (isTransientPath(resolvedPath)) return;
  try {
    const { loadConfig, saveConfig } = await import("../config");
    if (loadConfig().bundledPluginSource === resolvedPath) return;
    saveConfig({ bundledPluginSource: resolvedPath });
  } catch {}
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
        .find((candidate) => existsSync(candidate) && isPluginDir(candidate) && !isTransientPath(candidate));
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
 * Bug: #1186 — compiled binary lost the bundled-plugin path because
 * `import.meta.dir` no longer pointed at the source tree. Multi-source
 * resolver (`resolveBundledPath`) and source-mode auto-persist fix it.
 *
 * @param pluginDir  resolved ~/.maw/plugins/ path
 * @param srcDir     resolved src/ directory (pass import.meta.dir from cli.ts)
 */
export async function runBootstrap(pluginDir: string, srcDir: string): Promise<void> {
  mkdirSync(pluginDir, { recursive: true });

  // #1339 Option E — ensure `<pluginDir>/node_modules/maw-js` exists so any
  // installed plugin can resolve `import "maw-js/..."` via standard node
  // module walk-up. Idempotent; silent on no-op. The verbose log path
  // surfaces actual link creations / replacements only.
  try {
    const r = ensureMawJsResolvable();
    if (r.changed) {
      console.warn(`[maw] ${r.reason}`);
    }
  } catch { /* never fatal on bootstrap */ }

  // 0. #1015/#1449 — heal broken symlinks before anything else. After an
  //    update moves bundled plugins, old symlinks become dangling. If the
  //    same plugin exists in the resolved bundled root, silently re-link it;
  //    warn only for symlinks that cannot be healed.
  const bundled = await resolveBundledPath(srcDir);
  const vendored = join(srcDir, "vendor", "mpr-plugins");
  const bundledRoots = [bundled, vendored].filter((p): p is string => !!p && existsSync(p));
  const { pruned } = healOrPruneBrokenSymlinks(pluginDir, bundledRoots);
  if (pruned > 0) {
    console.warn(`[maw] removed ${pruned} broken plugin symlink${pruned === 1 ? "" : "s"} from ${pluginDir}`);
  }

  const wasEmpty = readdirSync(pluginDir).length === 0;

  // 1. Symlink any bundled plugin missing from pluginDir — IDEMPOTENT,
  //    runs every boot. Cheap (fs stat + symlink), no network.
  //
  // Auto-heal: if dest is a symlink pointing to a path that's NOT under the
  //   current bundled root (e.g., a deleted clone path), re-link it. Prevents
  //   silent "unknown command: tmux" after migrating between maw-js checkouts.
  if (bundled) {
    let healed = 0;
    for (const d of readdirSync(bundled)) {
      const src = join(bundled, d);
      const dest = join(pluginDir, d);
      if (!isPluginDir(src)) continue;
      if (existsSync(dest)) {
        // Heal: if dest is a symlink pointing to a stale bundled location,
        // re-link to the current bundled path. Plain dirs (user overrides)
        // are left alone.
        try {
          if (lstatSync(dest).isSymbolicLink()) {
            const target = readlinkSync(dest);
            // #1314 — never migrate TO a transient/worktree path. Only
            // re-link AWAY from broken/transient locations toward a stable
            // one. The opposite would write /tmp/...-worktree symlinks that
            // go dangling as soon as the worktree is removed.
            if (
              target !== src &&
              target.includes("/commands/plugins/") &&
              !isTransientPath(src)
            ) {
              unlinkSync(dest);
              symlinkSync(src, dest);
              healed++;
            }
          }
        } catch { /* leave alone */ }
        continue;
      }
      symlinkSync(src, dest);
      healed++;
    }
    if (healed > 0) {
      console.warn(`[maw] linked ${healed} bundled plugin${healed === 1 ? "" : "s"} to ${bundled}`);
    }
    // Source-mode boot? Persist the path so a later compiled-binary boot
    // can find the bundled plugins even after `import.meta.dir` stops
    // pointing at the source tree. Skip when the path came from env so
    // a transient `MAW_BUNDLED_PLUGINS` doesn't overwrite stored config.
    const fromSrc = join(srcDir, "commands", "plugins");
    if (bundled === fromSrc && !process.env.MAW_BUNDLED_PLUGINS) {
      await persistBundledPath(bundled);
    }
  } else if (wasEmpty || pruned > 0) {
    // #1314 — also warn when we pruned dangling symlinks AND can't find a
    // bundled source. Pre-#1314 this was `else if (wasEmpty)` which is
    // FALSE in real installs (registry plugins remain) — so the user
    // silently discovered the breakage via "unknown command: <bundled-plugin>".
    // Now: loud signpost + concrete recovery hint.
    console.warn(
      `[maw] bundled-plugin source not found — set MAW_BUNDLED_PLUGINS or ` +
      `'bundledPluginSource' in maw.config.json to the absolute path of ` +
      `src/commands/plugins in your maw-js checkout. (#1186 / #1314)`,
    );
    if (pruned > 0) {
      console.warn(
        `[maw] ${pruned} broken plugin symlink${pruned === 1 ? "" : "s"} were pruned but ` +
        `cannot be re-linked. Recovery: cd <stable-maw-js-checkout> && bun link maw-js`,
      );
    }
  }

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
