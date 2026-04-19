// Node.js launcher shim for maw-boot (src/cli.ts wake all --resume).
//
// Why this exists: PM2 wraps spawned processes with `require-in-the-middle`,
// which synchronously require()s the entry file. src/cli.ts is an ESM async
// module (uses top-level await), and require()ing it throws:
//
//   TypeError: require() async module "...\src\cli.ts" is unsupported.
//   use "await import()" instead.
//
// Result: maw-boot crash-loops on every pm2 start. This is especially visible
// on Windows but can affect any environment where PM2's APM hooks are active.
//
// Fix: PM2 spawns Node (safe, .cjs is require-compatible), Node spawns bun
// via child_process (bypasses the require-in-the-middle hook), bun runs
// cli.ts cleanly. Signals and exit codes forward so pm2's lifecycle works.

const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const IS_WIN = process.platform === "win32";

// Resolve bun binary:
//   1. $BUN_BIN env override (for non-standard installs)
//   2. Windows: %APPDATA%\npm\bun.cmd (npm-global install)
//   3. Linux/macOS: ~/.bun/bin/bun (curl installer default)
//   4. Fallback: "bun" on PATH
function resolveBun() {
  if (process.env.BUN_BIN && fs.existsSync(process.env.BUN_BIN)) {
    return process.env.BUN_BIN;
  }
  if (IS_WIN) {
    const npmBun = path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "npm",
      "bun.cmd",
    );
    if (fs.existsSync(npmBun)) return npmBun;
  } else {
    const homeBun = path.join(os.homedir(), ".bun", "bin", "bun");
    if (fs.existsSync(homeBun)) return homeBun;
  }
  return "bun";
}

const BUN_BIN = resolveBun();
const CLI = path.join(__dirname, "..", "src", "cli.ts");
const forwardedArgs = process.argv.slice(2);

// Pre-flight: fail loud if the CLI entry was renamed/moved since last deploy.
// Without this, a missing entry produces an opaque bun error buried in PM2
// logs and crash-loops against `max_restarts` — the exact 04-17 failure mode.
if (!fs.existsSync(CLI)) {
  console.error("[maw-boot launcher] entry not found: " + CLI);
  console.error("[maw-boot launcher] ecosystem drift — src/cli.ts was renamed or deleted.");
  console.error("[maw-boot launcher] run: bash scripts/check-ecosystem.sh");
  process.exit(2);
}

const child = spawn(BUN_BIN, ["run", CLI, ...forwardedArgs], {
  stdio: "inherit",
  // shell:true on Windows is required to execute .cmd files.
  shell: IS_WIN,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error("[maw-boot launcher] failed to spawn bun:", err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[maw-boot launcher] bun exited via signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

const forward = (sig) => {
  if (!child.killed) child.kill(sig);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
