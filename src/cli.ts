#!/usr/bin/env bun
process.env.MAW_CLI = "1";

import { cmdPeek, cmdSend } from "./commands/shared/comm";
import { logAudit } from "./core/fleet/audit";
import { usage } from "./cli/usage";
import { routeComm } from "./cli/route-comm";
import { routeTools } from "./cli/route-tools";
import { scanCommands, matchCommand, executeCommand } from "./cli/command-registry";
import { setVerbosityFlags } from "./cli/verbosity";
import { join } from "path";
import { homedir } from "os";

// Strip verbosity flags up-front so they don't collide with cmd detection or
// leak into plugin argv. Task #3 will flip call sites to honor these.
const VERBOSITY_FLAGS = new Set(["--quiet", "-q", "--silent", "-s"]);
const rawArgs = process.argv.slice(2);
const verbosity: { quiet?: boolean; silent?: boolean } = {};
if (rawArgs.some(a => a === "--quiet" || a === "-q")) verbosity.quiet = true;
if (rawArgs.some(a => a === "--silent" || a === "-s")) verbosity.silent = true;
setVerbosityFlags(verbosity);
const args = rawArgs.filter(a => !VERBOSITY_FLAGS.has(a));
const cmd = args[0]?.toLowerCase();

logAudit(cmd || "", args);

function getVersionString(): string {
  const pkg = require("../package.json");
  let hash = "";
  try { hash = require("child_process").execSync("git rev-parse --short HEAD", { cwd: import.meta.dir, stdio: "pipe" }).toString().trim(); } catch {}
  let buildDate = "";
  try {
    const raw = require("child_process").execSync("git log -1 --format=%ci", { cwd: import.meta.dir, stdio: "pipe" }).toString().trim();
    const d = new Date(raw);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    buildDate = `${raw.slice(0, 10)} ${days[d.getDay()]} ${raw.slice(11, 16)}`;
  } catch {}
  return `maw v${pkg.version}${hash ? ` (${hash})` : ""}${buildDate ? ` built ${buildDate}` : ""}`;
}

if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(getVersionString());
} else if (cmd === "update" || cmd === "upgrade") {
  const { execSync } = require("child_process");
  const { repository } = require("../package.json");
  let ref = args[1] || "main";

  const UPDATE_HELP_TEXT = [
    "usage: maw update [ref]",
    "",
    "  Update maw-js to a specific ref, channel, or branch.",
    "",
    "  Examples:",
    "    maw update          update to main (default)",
    "    maw update alpha    update to latest alpha tag",
    "    maw update beta     update to latest beta tag",
    "    maw update main     update to main branch",
    "",
    "  Flags:",
    "    --yes, -y     skip confirmation prompt (for scripts/fleet)",
    "    --help, -h    show this message and exit (no side effects)",
    "",
    "  ⚠ Manual `bun add -g` may loop — use `maw update <ref>` instead.",
  ].join("\n");

  // Layer 1: short-circuit --help/-h BEFORE any side effects (#356)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(UPDATE_HELP_TEXT);
    process.exit(0);
  }

  // Layer 2: reject refs that look like flags — defense-in-depth (#356)
  // Catches `maw update alpha --help` where --help somehow lands in args[1]
  if (ref.startsWith("--")) {
    console.error(`\x1b[31merror\x1b[0m: invalid ref "${ref}" — looks like a flag. Run \`maw update --help\` for usage.`);
    process.exit(1);
  }

  // Channel shortcut: "alpha" / "beta" → resolve to latest matching tag
  if (ref === "alpha" || ref === "beta") {
    const channel = ref;
    try {
      const output = execSync(
        `git ls-remote --tags --refs https://github.com/${repository}.git`,
        { encoding: "utf-8" }
      );
      const tags = output
        .split("\n")
        .map((line: string) => (line.split("\t")[1] || "").replace("refs/tags/", "").trim())
        .filter((t: string) => /^v\d+\.\d+\.\d+-\w+\.\d+$/.test(t) && t.includes(`-${channel}.`));
      if (tags.length === 0) {
        console.error(`\x1b[31merror\x1b[0m: no ${channel} tags in ${repository}`);
        process.exit(1);
      }
      tags.sort((a: string, b: string) => {
        const parse = (tag: string): number[] => {
          const m = tag.match(/^v(\d+)\.(\d+)\.(\d+)-\w+\.(\d+)$/);
          return m ? [+m[1], +m[2], +m[3], +m[4]] : [0, 0, 0, 0];
        };
        const pa = parse(a), pb = parse(b);
        for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
      });
      ref = tags[0];
      console.log(`\n  📍 ${channel} channel → ${ref}`);
    } catch (e: any) {
      console.error(`\x1b[31merror\x1b[0m: failed to resolve ${channel} channel: ${e.message}`);
      process.exit(1);
    }
  }

  const before = getVersionString();
  // Strip "maw " prefix so the arrow line stays readable: "v2.0.0-alpha.20 → v2.0.0-alpha.21"
  const beforeVer = before.replace(/^maw\s+/, "");
  const arrow = beforeVer === ref ? "\x1b[90m=\x1b[0m" : "\x1b[32m→\x1b[0m";
  const sameNote = beforeVer === ref ? " \x1b[90m(re-sync)\x1b[0m" : "";
  console.log(`\n  🍺 maw \x1b[36m${beforeVer}\x1b[0m ${arrow} \x1b[36m${ref}\x1b[0m${sameNote}\n`);

  // Confirmation gate — show from→to, ask before destructive install.
  // Skip with --yes/-y for scripted usage (e.g. fleet update).
  if (!args.includes("--yes") && !args.includes("-y")) {
    process.stdout.write("  proceed? [y/N] ");
    const buf = Buffer.alloc(8);
    const fd = require("fs").openSync("/dev/tty", "r");
    const n = require("fs").readSync(fd, buf, 0, buf.length, null);
    require("fs").closeSync(fd);
    const answer = buf.slice(0, n).toString().trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("  \x1b[90maborted\x1b[0m");
      process.exit(0);
    }
  }

  // Remove first to avoid bun dependency loop (#214)
  // Required: purges stale global refs that cause dep loops (#347)
  try { execSync(`bun remove -g maw`, { stdio: "pipe" }); } catch {}
  execSync(`bun add -g github:${repository}#${ref}`, { stdio: "inherit" });
  // Link SDK so plugins can `import { maw } from "@maw/sdk"` (workspace package at packages/sdk/)
  // Legacy plugins using bare `maw/sdk` are still resolved via `bun link maw`.
  try {
    const mawDir = join(execSync(`ghq list --full-path | tr '\\\\' '/' | grep 'Soul-Brews-Studio/maw-js$'`, { encoding: "utf-8" }).trim());
    if (mawDir) {
      // #346: Gate link on version match — stale ghq clone would override the fresh global install
      const cloneVersion: string = require(join(mawDir, "package.json")).version;
      const refNormalized = ref.replace(/^v/, "");
      if (ref !== "main" && !cloneVersion.includes(refNormalized)) {
        console.log(`  ⚠ SDK link skipped — local clone is ${cloneVersion}, installed ${ref}`);
      } else {
        execSync(`cd ${mawDir} && bun link`, { stdio: "pipe" });
        const oracleDir = join(homedir(), ".oracle");
        const { existsSync: exists, writeFileSync: writeFile } = require("fs");
        const { mkdirSync } = require("fs");
        mkdirSync(oracleDir, { recursive: true });
        if (!exists(join(oracleDir, "package.json"))) {
          writeFile(join(oracleDir, "package.json"), '{"name":"oracle-plugins","private":true}\n');
        }
        execSync(`cd ${oracleDir} && bun link maw`, { stdio: "pipe" });
        console.log(`  🔗 SDK linked (@maw/sdk)`);
      }
    }
  } catch { /* ghq not available or link failed — non-fatal */ }
  let after = "";
  try { after = execSync(`maw --version`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch {}

  // Refresh bundled plugin symlinks (point to new install)
  try {
    const pluginDir = join(homedir(), ".maw", "plugins");
    const { existsSync: ex, readdirSync: rd, lstatSync: ls, unlinkSync: ul, symlinkSync: sl } = require("fs");
    const { mkdirSync: mk } = require("fs");
    mk(pluginDir, { recursive: true });
    const mawBin = execSync("which maw", { encoding: "utf-8" }).trim();
    const mawSrc = require("path").dirname(require("fs").realpathSync(mawBin));
    const bundled = join(mawSrc, "commands", "plugins");
    if (ex(bundled)) {
      let refreshed = 0;
      for (const d of rd(bundled)) {
        if (ex(join(bundled, d, "plugin.json")) || ex(join(bundled, d, "index.ts"))) {
          const dest = join(pluginDir, d);
          // Replace old symlink or missing entry
          try { if (ls(dest).isSymbolicLink()) ul(dest); } catch {}
          if (!ex(dest)) { sl(join(bundled, d), dest); refreshed++; }
        }
      }
      if (refreshed > 0) console.log(`\n  🔗 ${refreshed} bundled plugins re-linked`);
    }
  } catch {}

  // Arrow confirmation — "before → after" mirrors the header but with the
  // actual resolved version (in case ref was 'main' or channel shortcut).
  const afterVer = after.replace(/^maw\s+/, "");
  if (afterVer) {
    const sameAfter = beforeVer === afterVer;
    const doneArrow = sameAfter ? "\x1b[90m=\x1b[0m" : "\x1b[32m→\x1b[0m";
    const doneNote = sameAfter ? " \x1b[90m(no change — re-sync\'d)\x1b[0m" : "";
    console.log(`\n  ✅ \x1b[36m${beforeVer}\x1b[0m ${doneArrow} \x1b[36m${afterVer}\x1b[0m${doneNote}\n`);
  } else {
    console.log(`\n  ✅ done\n`);
  }
} else {
  // Auto-bootstrap: if ~/.maw/plugins/ is empty, symlink bundled + install from pluginSources
  const pluginDir = join(homedir(), ".maw", "plugins");
  const { mkdirSync, existsSync, readdirSync, cpSync, writeFileSync, readFileSync, symlinkSync, lstatSync, unlinkSync } = require("fs");
  const { execSync } = require("child_process");
  mkdirSync(pluginDir, { recursive: true });
  if (readdirSync(pluginDir).length === 0) {
    // 1. Symlink bundled plugins (symlinks preserve relative imports)
    const bundled = join(import.meta.dir, "commands", "plugins");
    if (existsSync(bundled)) {
      for (const d of readdirSync(bundled)) {
        if (existsSync(join(bundled, d, "plugin.json")) || existsSync(join(bundled, d, "index.ts"))) {
          symlinkSync(join(bundled, d), join(pluginDir, d));
        }
      }
    }

    // 2. Install from pluginSources URLs in config
    try {
      const { loadConfig } = await import("./config");
      const config = loadConfig();
      const sources: string[] = config.pluginSources ?? [];
      for (const url of sources) {
        try {
          execSync(`ghq get -u "${url}"`, { stdio: "pipe" });
          const ghqRoot = execSync("ghq root", { encoding: "utf-8" }).trim();
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

  // Load plugins from ~/.maw/plugins/ — the single source of truth
  await scanCommands(pluginDir, "user");

  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
  } else {

  // Core routes: hey (transport) + plugin management + serve
  const handled =
    await routeComm(cmd, args) ||
    await routeTools(cmd, args);

  if (!handled) {
    // Try plugin commands (beta) — after core routes, before fallback
    const pluginMatch = matchCommand(args);
    if (pluginMatch) {
      await executeCommand(pluginMatch.desc, pluginMatch.remaining);
    } else {
      // Fallback: check plugin registry for bundled commands
      // #349/#351/#354 — prefix match MUST require word boundary. Loose
      // `startsWith(n)` lets alias "rest" of stop plugin match "restart --help"
      // and invoke destructive cmdSleep. Fix: require exact OR `n + " "` prefix.
      // Also: slice by the MATCHED name (alias or command), not always command,
      // so remaining args are computed correctly when an alias fires.
      const { discoverPackages, invokePlugin } = await import("./plugin/registry");
      const plugins = discoverPackages();
      const cmdName = args.join(" ").toLowerCase();
      let matched = false;
      for (const p of plugins) {
        if (!p.manifest.cli) continue;
        const names = [p.manifest.cli.command, ...(p.manifest.cli.aliases || [])];
        let matchedName: string | null = null;
        for (const n of names) {
          const lower = n.toLowerCase();
          if (cmdName === lower || cmdName.startsWith(lower + " ")) {
            matchedName = lower;
            break;
          }
        }
        if (matchedName) {
          matched = true;
          const remaining = cmdName.slice(matchedName.length).trim().split(/\s+/).filter(Boolean);
          const result = await invokePlugin(p, { source: "cli", args: remaining.length ? remaining : args.slice(1) });
          if (result.ok && result.output) console.log(result.output);
          else if (!result.ok) { console.error(result.error); process.exit(1); }
          process.exit(0);
        }
      }
      if (matched) { /* unreachable — kept for clarity */ }
      // Check for likely mistyped short commands before falling through to agent shorthand.
      // Heuristic: single arg, length <= 3, no hyphen (agent names are longer or hyphenated).
      // This catches `maw a`, `maw ls` typos, etc. without breaking `maw neo "hello"`.
      if (args.length === 1 && args[0].length <= 3 && !/[a-z]+-[a-z]+/.test(args[0])) {
        const knownCommands = plugins
          .map(p => p.manifest.cli?.command)
          .filter((c): c is string => Boolean(c));
        const suggestion = knownCommands.find(c => c.startsWith(args[0]));
        if (suggestion) {
          console.error(`\x1b[31munknown command\x1b[0m: '${args[0]}' — did you mean '${suggestion}'?`);
          process.exit(1);
        }
      }
      // Default: agent name shorthand (maw <agent> <msg> or maw <agent>)
      if (args.length >= 2) {
        const f = args.includes("--force");
        const m = args.slice(1).filter(a => a !== "--force");
        await cmdSend(args[0], m.join(" "), f);
      } else {
        await cmdPeek(args[0]);
      }
    }
  }
  }
}
