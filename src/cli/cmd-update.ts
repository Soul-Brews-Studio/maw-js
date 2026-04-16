import { execSync } from "child_process";
import {
  existsSync, writeFileSync, mkdirSync, readdirSync,
  lstatSync, unlinkSync, symlinkSync, openSync, readSync, closeSync, realpathSync,
} from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { getVersionString } from "./cmd-version";
import { ghqFindSync } from "../core/ghq";

export async function runUpdate(args: string[]): Promise<void> {
  const { repository } = require("../../package.json");
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
    const fd = openSync("/dev/tty", "r");
    const n = readSync(fd, buf, 0, buf.length, null);
    closeSync(fd);
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
    const mawDir = ghqFindSync("/Soul-Brews-Studio/maw-js");
    if (mawDir) {
      // #346: Gate link on version match — stale ghq clone would override the fresh global install
      const cloneVersion: string = require(join(mawDir, "package.json")).version;
      const refNormalized = ref.replace(/^v/, "");
      if (ref !== "main" && !cloneVersion.includes(refNormalized)) {
        console.log(`  ⚠ SDK link skipped — local clone is ${cloneVersion}, installed ${ref}`);
      } else {
        execSync(`cd ${mawDir} && bun link`, { stdio: "pipe" });
        const oracleDir = join(homedir(), ".oracle");
        mkdirSync(oracleDir, { recursive: true });
        if (!existsSync(join(oracleDir, "package.json"))) {
          writeFileSync(join(oracleDir, "package.json"), '{"name":"oracle-plugins","private":true}\n');
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
    mkdirSync(pluginDir, { recursive: true });
    const mawBin = execSync("which maw", { encoding: "utf-8" }).trim();
    const mawSrc = dirname(realpathSync(mawBin));
    const bundled = join(mawSrc, "commands", "plugins");
    if (existsSync(bundled)) {
      let refreshed = 0;
      for (const d of readdirSync(bundled)) {
        if (existsSync(join(bundled, d, "plugin.json")) || existsSync(join(bundled, d, "index.ts"))) {
          const dest = join(pluginDir, d);
          // Replace old symlink or missing entry
          try { if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest); } catch {}
          if (!existsSync(dest)) { symlinkSync(join(bundled, d), dest); refreshed++; }
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
}
