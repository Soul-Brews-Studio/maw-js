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
  let after = "";
  try { after = execSync(`maw --version`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch {}
  console.log(`\n  ✅ done`);
  if (after) console.log(`  to:   ${after}\n`);
  else console.log("");
} else if (!cmd || cmd === "--help" || cmd === "-h") {
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
