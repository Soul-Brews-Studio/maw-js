/**
 * maw token — shared helpers.
 *
 * Port of token-oracle/lib/__init__.py + lib/envrc.py.
 *
 * Security invariants:
 *   - Token values are held in memory only — never logged, printed, or
 *     embedded in error messages. Functions that touch raw token text
 *     (passShow, fingerprintTokens) return values to the caller; the
 *     caller MUST treat them as secret material.
 *   - Subprocess calls to `pass` NEVER take a token value as a CLI arg;
 *     writes use stdin (`pass insert --multiline`), reads stream from
 *     stdout into memory only.
 *   - `redact()` is the single chokepoint for any string that might
 *     have transited a token (use it for audit-log paths, never for
 *     normal output).
 */

export const PASS_PREFIX = "envrc";
export const TOKEN_PREFIX = "claude/token-";

export interface RunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** UTF-8 text fed to stdin. */
  stdin?: string;
  /** Working directory for the child. */
  cwd?: string;
  /** Env overrides (merged onto process.env). */
  env?: Record<string, string>;
}

/**
 * Run a subprocess, capture stdout/stderr, return RunResult.
 *
 * Uses Bun.spawnSync (pure Bun, no node:child_process) so tests can
 * monkey-patch this single entry point and exercise the rest of the
 * plugin without a real `pass` vault or `direnv` binary. The runner
 * is exposed as `_runOverride` for the test harness — production code
 * goes through `run()`.
 */
let _runOverride: ((cmd: string[], opts?: RunOptions) => RunResult) | null = null;

export function setRunOverride(
  fn: ((cmd: string[], opts?: RunOptions) => RunResult) | null,
): void {
  _runOverride = fn;
}

export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  if (_runOverride) return _runOverride(cmd, opts);

  // Bun.spawnSync — accepts `stdin` as bytes (TypedArray) or "pipe".
  // We pass the encoded text directly so `pass insert --multiline` reads
  // .envrc content without it ever appearing in argv.
  const spawnOpts: any = {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  };
  if (opts.stdin !== undefined) {
    spawnOpts.stdin = new TextEncoder().encode(opts.stdin);
  }
  const proc = Bun.spawnSync(cmd, spawnOpts);

  const dec = new TextDecoder();
  const stdout = proc.stdout instanceof Uint8Array ? dec.decode(proc.stdout) : String(proc.stdout ?? "");
  const stderr = proc.stderr instanceof Uint8Array ? dec.decode(proc.stderr) : String(proc.stderr ?? "");

  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode ?? 1,
    stdout,
    stderr,
  };
}

/** Returns true if `pass show <name>` exits 0 (i.e. entry exists). */
export function passExists(name: string): boolean {
  return run(["pass", "show", name]).ok;
}

/** Use provided name or fall back to current directory basename. */
export function defaultName(name: string | undefined, cwd: string = process.cwd()): string {
  if (name) return name;
  const base = cwd.replace(/\/+$/, "").split("/").pop();
  return base || "default";
}

/** Strip ANSI color/formatting codes (pass ls is colored). */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Detect active Claude token name from .envrc content.
 *
 * Returns the token name (e.g. "foo") or null if no recognised format
 * is present. NEVER returns the token value itself.
 *
 * Formats supported (precedence):
 *   1. New:    export CLAUDE_TOKEN_NAME="foo"
 *   2. Direct: export CLAUDE_CODE_OAUTH_TOKEN="$(pass show claude/token-foo)"
 *   3. Legacy: export CLAUDE_CODE_OAUTH_TOKEN=$TOKEN_FOO
 *              + TOKEN_FOO="$(pass show claude/token-foo)"
 */
export function detectActiveToken(content: string): string | null {
  // Skip commented lines for matching.
  const active = content
    .split("\n")
    .filter(l => !l.replace(/^\s+/, "").startsWith("#"))
    .join("\n");

  // Format 1: CLAUDE_TOKEN_NAME
  let m = /CLAUDE_TOKEN_NAME="([^"]+)"/.exec(active);
  if (m) return m[1];

  // Format 2: direct pass show in export line
  m = /export\s+CLAUDE_CODE_OAUTH_TOKEN="?\$\(pass show claude\/token-([\w\-.]+)\)"?/.exec(active);
  if (m) return m[1];

  // Format 3: var ref (TOKEN_FOO) — find var, then its pass source
  m = /export\s+CLAUDE_CODE_OAUTH_TOKEN=\$(\w+)/.exec(active);
  if (m) {
    const varName = m[1];
    const pat = new RegExp(`${varName}="?\\$\\(pass show claude/token-([\\w\\-.]+)\\)"?`);
    const m2 = pat.exec(active);
    if (m2) return m2[1];
  }

  return null;
}

/**
 * Redact known token env-var values from a string. Used for any
 * caller-facing audit log that might quote .envrc contents or error
 * output. Substring approach (not regex over the secret) keeps the
 * actual value out of compiled patterns.
 *
 * Caller passes the value to redact (held in memory by fingerprintTokens
 * or passShow). Returns the original string with every occurrence of
 * `value` replaced by `***REDACTED***`.
 */
export function redact(text: string, ...secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue; // refuse to redact short strings
    // Split-join is safer than RegExp constructed from the secret: a
    // crafted secret could contain regex metacharacters.
    out = out.split(s).join("***REDACTED***");
  }
  return out;
}

/** Interactive y/N prompt. Returns false on Ctrl+C, EOF, or non-TTY. */
export async function confirm(msg: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${msg} [y/N] `);
  return await new Promise<boolean>(resolve => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const line = buf.split("\n")[0];
      if (buf.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(line.trim().toLowerCase() === "y");
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("error", () => resolve(false));
    process.stdin.once("end", () => resolve(false));
  });
}

/**
 * List token names in `pass`. Parses `pass ls claude` output. Returns
 * an empty array when pass is missing, vault is empty, or the entry
 * has no `token-<name>` children — callers should treat empty as a
 * non-error condition.
 */
export function listTokenNames(): string[] {
  const r = run(["pass", "ls", "claude"]);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const raw of r.stdout.split("\n")) {
    const clean = stripAnsi(raw);
    const m = /token-(\S+)/.exec(clean);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * List saved .envrc names in `pass` (under PASS_PREFIX). Skips
 * directory markers and header lines from colourised `pass ls` output.
 */
export function listEnvrcNames(): string[] {
  const r = run(["pass", "ls", PASS_PREFIX]);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const raw of r.stdout.split("\n")) {
    const clean = stripAnsi(raw).trim();
    if (!clean) continue;
    if (clean.endsWith("/")) continue;
    if (clean.includes("Password Store")) continue;
    const m = /([\w\-.]+)\s*$/.exec(clean);
    if (m && m[1] !== PASS_PREFIX) out.push(m[1]);
  }
  return out;
}

/**
 * Build the fingerprint map { tokenValue → name } used by scan to
 * match .envrc files containing literal secrets.
 *
 * **SECURITY**: the returned map's KEYS are full token values. Held
 * in memory only. NEVER iterate this map for any print/log path; only
 * for `content.includes(tokenValue)` membership tests.
 */
export function fingerprintTokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of listTokenNames()) {
    const r = run(["pass", "show", `${TOKEN_PREFIX}${name}`]);
    if (!r.ok) continue;
    const token = r.stdout.trim();
    if (token.length >= 8) out.set(token, name);
  }
  return out;
}
