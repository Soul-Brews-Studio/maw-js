import { execSync } from "child_process";
import {
  existsSync, writeFileSync, mkdirSync, readdirSync,
  lstatSync, unlinkSync, symlinkSync, openSync, readSync, closeSync, realpathSync,
  renameSync, rmSync,
} from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { getVersionString } from "./cmd-version";
import { ghqFindSync } from "../core/ghq";
import { withUpdateLock } from "./update-lock";

export async function runUpdate(args: string[]): Promise<void> {
  const { repository } = require("../../package.json");
  // args[0] is "update"; first non-flag positional is the ref.
  // Prevents `maw update --yes` from treating "--yes" as a ref (alpha.72 fix).
  const positionals = args.slice(1).filter(a => !a.startsWith("-"));
  let ref = positionals[0] || "main";

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

  // Layer 2: reject unknown flag-looking args — defense-in-depth (#356).
  // Catches typos like `--yess` for `--yes`. Known flags are allowed; positional
  // filter above already extracted the ref, so a bad flag here is user error.
  const KNOWN_FLAGS = new Set(["--yes", "-y", "--help", "-h"]);
  const unknownFlag = args.slice(1).find(a => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknownFlag) {
    console.error(`\x1b[31merror\x1b[0m: invalid ref "${unknownFlag}" — looks like a flag. Run \`maw update --help\` for usage.`);
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
    // Non-interactive environments (Claude Code sandbox, CI, piped) have no
    // /dev/tty → openSync would throw ENXIO. Bail with an actionable hint
    // instead (alpha.72 fix — reported by user trying `maw update` in a
    // non-TTY sandbox).
    if (!process.stdin.isTTY) {
      console.error("  \x1b[31m✗\x1b[0m non-interactive environment — re-run with --yes (or -y) to skip confirmation");
      process.exit(1);
    }
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

  // Allowlist: git tag names, branch names, commit SHAs — no shell metacharacters.
  // Channel shortcuts ("alpha"/"beta") resolve to a validated tag above; all
  // resolved refs must still pass this gate (defense-in-depth after channel resolve).
  // CRITICAL: this MUST run BEFORE `bun remove -g maw` below. If validation
  // fails after remove, the user is left with maw uninstalled and no reinstall.
  // (Regression: #356/#473-class. Fix 2026-04-18 — emergency after user report.)
  const REF_RE = /^[a-zA-Z0-9._\-\/]+$/;
  if (!REF_RE.test(ref)) {
    console.error(`\x1b[31merror\x1b[0m: invalid ref "${ref}" — only [a-zA-Z0-9._-/] characters permitted`);
    process.exit(1);
  }

  // Atomic install sequence — try install over existing FIRST so that a
  // transient failure (network, auth, bun version) cannot leave the user
  // with an uninstalled maw. `bun remove` only runs as a fallback when the
  // initial install fails — the historical reason for remove-first was a
  // dep-loop class (#214/#347), which is narrower than "every install".
  //
  // Order matters: validation (above) → try add → on fail, remove + retry →
  // on still-fail, print recovery command. User always has a working maw
  // unless BOTH adds fail.
  // #551 — serialize concurrent `maw update` invocations via filesystem lock.
  // Channel-resolve + validation above runs unlocked; destructive install ops
  // below (stash, bun remove, bun add, link refresh) are serialized.
  await withUpdateLock(async () => {
    const spawnInstall = () => Bun.spawn(["bun", "add", "-g", `github:${repository}#${ref}`], {
      stdio: ["inherit", "inherit", "inherit"],
    });

    let installCode = await spawnInstall().exited;
    if (installCode !== 0) {
      console.warn(`\x1b[33m⚠\x1b[0m first install attempt failed — clearing stale global refs and retrying`);
      // #551 — stash the current binary before destructive 'bun remove -g'.
      // If the retry also fails, we restore from stash so the user never ends up
      // with no maw. Empty-try around rename: stash is best-effort, retry not blocked.
      const BIN = join(homedir(), ".bun", "bin", "maw");
      const STASH = `${BIN}.prev`;
      let stashed = false;
      // Refuse if .prev already exists — that's a prior crashed update's
      // last-known-good escape hatch; silently overwriting would destroy it
      // (architect's gotcha on #551). User resolves explicitly.
      if (existsSync(STASH)) {
        console.error(`\x1b[31merror\x1b[0m: ${STASH} already exists (prior update crashed — last-known-good binary).`);
        console.error(`  restore manually:  mv ${STASH} ${BIN}`);
        console.error(`  or discard it:     rm ${STASH}   \x1b[90m# only if you're sure\x1b[0m`);
        console.error(`  then re-run:       maw update ${ref}`);
        process.exit(1);
      }
      try {
        if (existsSync(BIN)) {
          renameSync(BIN, STASH);
          stashed = true;
        }
      } catch { /* stash best-effort */ }

      // #697 — use the PACKAGE name (`maw-js`), not the bin name (`maw`).
      // `bun remove -g maw` is a silent no-op because bun looks up by package
      // name in ~/.bun/install/global/package.json, and the package registered
      // there is `maw-js`. Leaving the old ref in that manifest (e.g. pinning
      // `maw-js: github:.../#v26.4.19-alpha.15`) was the actual persistent
      // source of the dep-loop across every retry — bun kept merging the
      // stale pin into its graph alongside the new resolution. Removing by
      // package name evicts the pin from global package.json cleanly.
      try { execSync(`bun remove -g maw-js`, { stdio: "pipe" }); } catch {}
      try { execSync(`bun remove -g maw`, { stdio: "pipe" }); } catch {}

      // #697 — also evict bun's global lockfiles + any cached maw-js tarballs.
      // `bun remove` clears the package entry but bun.lock/bun.lockb pin
      // the *previous* ref's commit SHA, and `~/.bun/install/cache/` may hold
      // a stale tarball. When an annotated tag's ref points to the tag object
      // SHA rather than the commit SHA (tag-object polymorphism), bun's
      // resolver can get stuck re-resolving to the cached/pinned SHA — the
      // dep-loop. Nuke these so the retry resolves from scratch.
      try {
        const bunGlobal = join(homedir(), ".bun", "install", "global");
        for (const f of ["bun.lock", "bun.lockb"]) {
          const p = join(bunGlobal, f);
          try { if (existsSync(p)) unlinkSync(p); } catch {}
        }
      } catch {}
      try {
        const cacheDir = join(homedir(), ".bun", "install", "cache");
        if (existsSync(cacheDir)) {
          for (const entry of readdirSync(cacheDir)) {
            if (entry.includes("maw-js")) {
              try { rmSync(join(cacheDir, entry), { recursive: true, force: true }); } catch {}
            }
          }
        }
      } catch {}

      installCode = await spawnInstall().exited;

      if (installCode !== 0) {
        // #697 — Fallback: download pre-built binary from GitHub release
        // (bypasses bun's resolver entirely). calver-release.yml attaches `maw`
        // as a release asset. Works around bun's annotated-tag-SHA dep-loop
        // bug and any future resolver regressions. Only meaningful when `ref`
        // is a release tag — for branches/SHAs the curl 404s and we fall
        // through to the existing error path.
        console.warn(`\x1b[33m↺\x1b[0m bun add failed — trying release-binary fallback`);
        const releaseUrl = `https://github.com/${repository}/releases/download/${ref}/maw`;
        const dl = Bun.spawn(["curl", "-fsSL", "-o", BIN, releaseUrl], { stdout: "inherit", stderr: "inherit" });
        const dlCode = await dl.exited;
        if (dlCode === 0) {
          await Bun.spawn(["chmod", "+x", BIN]).exited;
          const v = Bun.spawn(["maw", "--version"], { stdout: "pipe" });
          const versionOk = (await v.exited) === 0;
          if (versionOk) {
            console.log(`\x1b[32m✓\x1b[0m installed via release binary (bun resolver bypassed)`);
            installCode = 0;
          }
        }
      }

      if (installCode !== 0 && stashed && existsSync(STASH)) {
        // Retry failed — restore the previous binary so the user isn't stranded.
        try {
          renameSync(STASH, BIN);
          console.warn(`\x1b[33m↺\x1b[0m restored previous maw binary from stash`);
        } catch (e: any) {
          console.error(`failed to restore stash: ${e.message || e}`);
        }
      } else if (installCode === 0 && stashed && existsSync(STASH)) {
        // Retry succeeded — clean up the stash.
        try { unlinkSync(STASH); } catch {}
      }
    }
    if (installCode !== 0) {
      console.error(`\x1b[31merror\x1b[0m: bun add failed with exit ${installCode} — previous maw restored from stash (if available)`);
      console.error(`  manual recovery: bun add -g github:${repository}#alpha`);
      process.exit(installCode);
    }
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
  });
}
