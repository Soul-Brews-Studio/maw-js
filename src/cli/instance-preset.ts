/**
 * Instance preset — parses `--as <name>` out of process.argv and sets
 * `MAW_HOME` BEFORE any state-touching module (like src/core/paths.ts) is
 * imported. Must be the first thing cli.ts does.
 *
 * Part of issue #566: multi-instance foundation. Enables running
 *   `maw serve 5001 --as dev`
 *   `maw serve 5002 --as prod`
 * as independent federation nodes on one host, each with their own
 * `~/.maw/inst/<name>/` home.
 *
 * When --as is absent OR the command is not `serve`, this is a no-op and
 * behavior is byte-identical to pre-#566.
 */
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

/** Same shape as node/oracle names — lowercase, digits, dashes, underscores. */
export const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Scan argv for `--as <name>` and apply it. Only triggers when the first
 * non-flag positional is `serve` — other verbs do not get per-invocation
 * instance selection in this PR (follow-up).
 *
 * Mutates process.env.MAW_HOME on success. Exits(1) with a clear error
 * message on invalid name.
 */
export function applyInstancePreset(argv: string[] = process.argv.slice(2)): void {
  // Find --as flag
  const asIdx = argv.indexOf("--as");
  if (asIdx === -1) return;

  // Only applies to `maw serve` for now. Other verbs → silently ignore,
  // leaves the flag for downstream parsers (which today reject it as
  // unknown — that's acceptable; tracked as follow-up).
  const firstPositional = argv.find(a => !a.startsWith("-"));
  if (firstPositional !== "serve") return;

  const name = argv[asIdx + 1];
  if (!name || name.startsWith("-")) {
    console.error(`\x1b[31m✗\x1b[0m --as requires an instance name`);
    console.error(`  usage: maw serve [port] --as <name>`);
    process.exit(1);
  }

  if (!INSTANCE_NAME_RE.test(name)) {
    console.error(`\x1b[31m✗\x1b[0m invalid instance name '${name}'`);
    console.error(`  must match ${INSTANCE_NAME_RE} (lowercase alnum + _ -, start alnum, ≤32 chars)`);
    process.exit(1);
  }

  const home = join(homedir(), ".maw", "inst", name);
  mkdirSync(home, { recursive: true });
  process.env.MAW_HOME = home;

  // Convenience: symlink <home>/plugins → ~/.maw/plugins so instances share
  // the plugin pool (plugins are not migrated per the #566 contract).
  // Atomic: symlinkSync throws EEXIST if the link is already there — we just
  // swallow it. No TOCTOU gap. Other errors are also non-fatal (best-effort).
  try {
    const { symlinkSync } = require("fs");
    const target = join(homedir(), ".maw", "plugins");
    symlinkSync(target, join(home, "plugins"), "dir");
  } catch { /* already linked, target missing, or permissions — best-effort */ }
}
