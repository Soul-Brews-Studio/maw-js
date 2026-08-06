/**
 * Minimal flag parser — covers only the flags maw-bg actually uses.
 *
 * TEMP: inlined per RFC#1 §"Capabilities + dependencies" + lean-core
 * task #6 P3. The full `parseFlags` lives in `maw-js/src/cli/parse-args.ts`
 * (built on the `arg` package). Will be replaced by an SDK re-export
 * once the public surface lands — see
 * https://github.com/Soul-Brews-Studio/maw-js/issues/844.
 *
 * Supported flag shapes:
 *   --name VALUE   --name=VALUE
 *   --lines N      --lines=N
 *   --older-than DUR  --older-than=DUR
 *   --follow / --dry-run / --all / --json / --help / -h  (boolean)
 *
 * Unknown flags are tolerated (left in `_` as positionals) so callers
 * can layer their own validation on top.
 */

export interface BgFlags {
  name?: string;
  lines?: number;
  follow?: boolean;
  dryRun?: boolean;
  olderThan?: string;
  all?: boolean;
  json?: boolean;
  help?: boolean;
  /** positional args, in order */
  _: string[];
}

const STRING_FLAGS = new Set(["--name", "--lines", "--older-than"]);
const BOOL_FLAGS = new Set([
  "--follow", "--dry-run", "--all", "--json", "--help", "-h",
]);

export function parseFlags(argv: string[]): BgFlags {
  const out: BgFlags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      // remainder is positional
      for (let j = i + 1; j < argv.length; j++) out._.push(argv[j]);
      break;
    }
    if (!tok.startsWith("-")) { out._.push(tok); continue; }

    // --flag=value form
    const eq = tok.indexOf("=");
    let key = eq >= 0 ? tok.slice(0, eq) : tok;
    let val: string | undefined = eq >= 0 ? tok.slice(eq + 1) : undefined;

    if (BOOL_FLAGS.has(key)) {
      assignBool(out, key, true);
      continue;
    }
    if (STRING_FLAGS.has(key)) {
      if (val === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          throw new Error(`flag ${key} requires a value`);
        }
        val = next;
        i++;
      }
      assignString(out, key, val);
      continue;
    }

    // unknown flag — push to positionals so caller can reject if it cares
    out._.push(tok);
  }
  return out;
}

function assignBool(f: BgFlags, key: string, v: boolean): void {
  switch (key) {
    case "--follow": f.follow = v; break;
    case "--dry-run": f.dryRun = v; break;
    case "--all": f.all = v; break;
    case "--json": f.json = v; break;
    case "--help": case "-h": f.help = v; break;
  }
}

function assignString(f: BgFlags, key: string, v: string): void {
  switch (key) {
    case "--name": f.name = v; break;
    case "--lines": {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--lines must be a positive number, got ${v}`);
      }
      f.lines = Math.floor(n);
      break;
    }
    case "--older-than": f.olderThan = v; break;
  }
}
