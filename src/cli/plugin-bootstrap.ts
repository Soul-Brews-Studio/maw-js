import { mkdirSync, existsSync, readdirSync, symlinkSync, cpSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

/** Allowlist: only http/https URLs may be used as plugin sources */
const URL_SCHEME_RE = /^https?:\/\//;

/**
 * Auto-bootstrap plugins into pluginDir if empty.
 * Symlinks bundled plugins and installs from pluginSources config URLs.
 *
 * @param pluginDir  resolved ~/.maw/plugins/ path
 * @param srcDir     resolved src/ directory (pass import.meta.dir from cli.ts)
 */
export async function runBootstrap(pluginDir: string, srcDir: string): Promise<void> {
  mkdirSync(pluginDir, { recursive: true });
  if (readdirSync(pluginDir).length === 0) {
    // 1. Symlink bundled plugins (symlinks preserve relative imports)
    const bundled = join(srcDir, "commands", "plugins");
    if (existsSync(bundled)) {
      for (const d of readdirSync(bundled)) {
        if (existsSync(join(bundled, d, "plugin.json")) || existsSync(join(bundled, d, "index.ts"))) {
          symlinkSync(join(bundled, d), join(pluginDir, d));
        }
      }
    }

    // 2. Install from pluginSources URLs in config
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
