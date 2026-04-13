#!/usr/bin/env bun
process.env.MAW_CLI = "1";

import { cmdPeek, cmdSend } from "./commands/comm";
import { logAudit } from "./audit";
import { usage } from "./cli/usage";
import { routeComm } from "./cli/route-comm";
import { routeAgent } from "./cli/route-agent";
import { routeFleet } from "./cli/route-fleet";
import { routeWorkspace } from "./cli/route-workspace";
import { routeTools } from "./cli/route-tools";
import { routeTeam } from "./cli/route-team";
import { scanCommands, matchCommand, executeCommand, listCommands } from "./cli/command-registry";
import { join } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
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
  const ref = args[1] || "main";
  const before = getVersionString();
  console.log(`\n  🍺 maw update ${ref}\n`);
  console.log(`  from: ${before}`);
  // Remove first to avoid bun dependency loop (#214)
  try { execSync(`bun remove -g maw`, { stdio: "pipe" }); } catch {}
  execSync(`bun add -g github:${repository}#${ref}`, { stdio: "inherit" });
  // Link SDK so plugins can `import { maw } from "maw/sdk"`
  try {
    const mawDir = join(execSync(`ghq list --full-path | grep 'Soul-Brews-Studio/maw-js$'`, { encoding: "utf-8" }).trim());
    if (mawDir) {
      execSync(`cd ${mawDir} && bun link`, { stdio: "pipe" });
      const oracleDir = join(homedir(), ".oracle");
      const { existsSync: exists, writeFileSync: writeFile } = require("fs");
      const { mkdirSync } = require("fs");
      mkdirSync(oracleDir, { recursive: true });
      if (!exists(join(oracleDir, "package.json"))) {
        writeFile(join(oracleDir, "package.json"), '{"name":"oracle-plugins","private":true}\n');
      }
      execSync(`cd ${oracleDir} && bun link maw`, { stdio: "pipe" });
      console.log(`  🔗 SDK linked (maw/sdk)`);
    }
  } catch { /* ghq not available or link failed — non-fatal */ }
  let after = "";
  try { after = execSync(`maw --version`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch {}
  console.log(`\n  ✅ done`);
  if (after) console.log(`  to:   ${after}\n`);
  else console.log("");
} else {
  // Auto-bootstrap: if ~/.maw/plugins/ is empty, copy core plugins from bundled
  const pluginDir = join(homedir(), ".maw", "plugins");
  const { mkdirSync, existsSync, readdirSync, cpSync } = require("fs");
  mkdirSync(pluginDir, { recursive: true });
  if (readdirSync(pluginDir).length === 0) {
    const bundled = join(import.meta.dir, "commands", "plugins");
    if (existsSync(bundled)) {
      for (const d of readdirSync(bundled)) {
        if (existsSync(join(bundled, d, "plugin.json")) || existsSync(join(bundled, d, "index.ts"))) {
          cpSync(join(bundled, d), join(pluginDir, d), { recursive: true });
        }
      }
      console.log(`[maw] bootstrapped ${readdirSync(pluginDir).length} plugins → ${pluginDir}`);
    }
  }

  // Load plugins from ~/.maw/plugins/ — the single source of truth
  await scanCommands(pluginDir, "user");

  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
  } else {

  const handled =
    await routeComm(cmd, args) ||
    await routeTeam(cmd, args) ||
    await routeAgent(cmd, args) ||
    await routeFleet(cmd, args) ||
    await routeWorkspace(cmd, args) ||
    await routeTools(cmd, args);

  if (!handled) {
    // Try plugin commands (beta) — after core routes, before fallback
    const pluginMatch = matchCommand(args);
    if (pluginMatch) {
      await executeCommand(pluginMatch.desc, pluginMatch.remaining);
    } else {
      // Fallback: check plugin registry for bundled commands
      const { discoverPackages, invokePlugin } = await import("./plugin/registry");
      const plugins = discoverPackages();
      const cmdName = args.join(" ").toLowerCase();
      for (const p of plugins) {
        if (!p.manifest.cli) continue;
        const names = [p.manifest.cli.command, ...(p.manifest.cli.aliases || [])];
        if (names.some(n => cmdName.startsWith(n.toLowerCase()))) {
          const remaining = cmdName.slice(p.manifest.cli.command.length).trim().split(/\s+/).filter(Boolean);
          const result = await invokePlugin(p, { source: "cli", args: remaining.length ? remaining : args.slice(1) });
          if (result.ok && result.output) console.log(result.output);
          else if (!result.ok) { console.error(result.error); process.exit(1); }
          process.exit(0);
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
