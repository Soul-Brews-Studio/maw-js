/**
 * `maw promote <window>` — eject a tmux window into a new standalone session.
 *
 * Inverse of `maw bring` / `maw take`:
 *   • bring/take = absorb window into another session (split-window / join-pane)
 *   • promote    = eject window into a fresh standalone session (new-session + move-window)
 *
 * Issue: #1910
 */

import { tmux } from "../../sdk";
import { UserError } from "../../core/util/user-error";
import { parseFlags } from "../../cli/parse-args";
// wake-cmd.ts is dynamically imported in cmdPromote (not at module top) so
// top-aliases.ts can statically import this file without dragging the full
// wake/config dep chain into test mocks (top-aliases tests mock maw-js/config
// without exporting cfgLimit/etc; static import would break their link step).

interface ResolvedWindow {
  session: string;
  window: string;
}

type ResolveResult = ResolvedWindow | { kind: "none" } | { kind: "ambiguous"; candidates: ResolvedWindow[] };

function targetSession(target: string): string {
  return target.split(":")[0] || target;
}

function targetWindow(target: string): string | null {
  const win = target.split(":").slice(1).join(":").trim();
  return win.length > 0 ? win : null;
}

const PROMOTE_PLACEHOLDER = "__promote_placeholder__";

/**
 * Resolve a target string to a concrete tmux session:window pair.
 *
 *   • `session:window` form → trust as-is
 *   • bare `window` form    → scan all sessions; exactly one window match wins
 *
 * @internal — exported for tests.
 */
export async function resolvePromoteTarget(
  target: string,
  listAllFn: () => Promise<{ name: string; windows: { name: string }[] }[]>,
): Promise<ResolveResult> {
  const explicitSession = targetSession(target);
  const explicitWindow = targetWindow(target);

  if (explicitWindow) {
    return { session: explicitSession, window: explicitWindow };
  }

  const sessions = await listAllFn();
  const matches: ResolvedWindow[] = [];
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name === target) matches.push({ session: s.name, window: w.name });
    }
  }

  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return matches[0]!;
  return { kind: "ambiguous", candidates: matches };
}

/** @internal — exported for test injection. */
export interface CmdPromoteDeps {
  listAll?: () => Promise<{ name: string; windows: { name: string }[] }[]>;
  hasSession?: (name: string) => Promise<boolean>;
  listWindows?: (session: string) => Promise<{ name: string }[]>;
  newSession?: (name: string, opts: { window?: string }) => Promise<string | undefined>;
  killSession?: (name: string) => Promise<void>;
  killWindow?: (target: string) => Promise<void>;
  run?: (subcommand: string, ...args: string[]) => Promise<string>;
  switchClient?: (session: string, opts?: { readonly?: boolean }) => Promise<void>;
  callerInTmux?: () => boolean;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function printPromoteUsage(write: (line: string) => void): void {
  write("usage: maw promote <window> [--as <name>] [--attach] [--force]");
  write("  Eject a tmux window into a new standalone session.");
  write("  <window>    session:window (qualified) OR bare window name (fuzzy resolve)");
  write("  --as        explicit destination session name (default: derived from window)");
  write("  --attach    switch-client to the new session after promote");
  write("  --force     merge into existing destination session instead of refusing");
  write("");
  write("  e.g. maw promote 77-mawjs:test-cli              → new session 'test-cli' (or NN- prefixed)");
  write("       maw promote 77-mawjs:test-cli --as my-iso  → new session 'my-iso'");
  write("       maw promote test-cli --attach              → fuzzy resolve + switch-client");
}

export async function cmdPromote(argv: string[], deps: CmdPromoteDeps = {}): Promise<void> {
  const flags = parseFlags(argv, {
    "--as": String,
    "--attach": Boolean,
    "--force": Boolean,
  }, 0);

  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  const target = (flags._ as string[])[0];
  if (!target || target === "--help" || target === "-h") {
    printPromoteUsage(error);
    if (target === "--help" || target === "-h") return;
    throw new UserError("promote: missing window");
  }

  const listAllFn = deps.listAll ?? (() => tmux.listAll());
  const hasSessionFn = deps.hasSession ?? ((name) => tmux.hasSession(name));
  const listWindowsFn = deps.listWindows ?? ((session) => tmux.listWindows(session));
  const newSessionFn = deps.newSession ?? ((name, opts) => tmux.newSession(name, opts));
  const killSessionFn = deps.killSession ?? ((name) => tmux.killSession(name));
  const killWindowFn = deps.killWindow ?? ((t) => tmux.killWindow(t));
  const runFn = deps.run ?? ((sub, ...args) => tmux.run(sub, ...args));
  const switchClientFn = deps.switchClient ?? ((s, opts) => tmux.switchClient(s, opts));
  const callerInTmux = deps.callerInTmux ?? (() => Boolean(process.env.TMUX));

  // 1. Resolve target window.
  const resolved = await resolvePromoteTarget(target, listAllFn);
  if ("kind" in resolved && resolved.kind === "none") {
    throw new UserError(`promote: no window matches '${target}'`);
  }
  if ("kind" in resolved && resolved.kind === "ambiguous") {
    error(`  \x1b[31m✗\x1b[0m '${target}' is ambiguous — promote which?`);
    for (const c of resolved.candidates) {
      error(`      \x1b[90m• ${c.session}:${c.window}\x1b[0m`);
    }
    error(`      \x1b[90muse: maw promote <session>:<window>\x1b[0m`);
    throw new UserError(`promote: '${target}' matches ${resolved.candidates.length} windows`);
  }

  const { session: srcSession, window: srcWindow } = resolved as ResolvedWindow;
  const srcTarget = `${srcSession}:${srcWindow}`;

  // 2. Safety: source must not be the only window in its session (Q3 γ).
  let srcWindowCount: number;
  try {
    const wins = await listWindowsFn(srcSession);
    srcWindowCount = wins.length;
  } catch (e: unknown) {
    throw new UserError(
      `promote: cannot list windows in source session '${srcSession}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (srcWindowCount <= 1) {
    error(`  \x1b[31m✗\x1b[0m promote refused — '${srcWindow}' is the only window in session '${srcSession}'.`);
    error(`      \x1b[90mthat would just be a session rename, not an eject.\x1b[0m`);
    error(`      \x1b[90muse: tmux rename-session -t ${srcSession} <new-name>\x1b[0m`);
    throw new UserError(`promote: source '${srcWindow}' is the only window in '${srcSession}'`);
  }

  // 3. Destination session name (Q2 — match chooseWakeSessionName).
  // Dynamic import so wake-cmd's transitive deps don't load via top-aliases.ts
  // static import path (some test mocks don't export every config helper).
  const { chooseWakeSessionName, validateForeignSessionName } = await import("./wake-cmd");
  let dstSession: string;
  if (flags["--as"]) {
    validateForeignSessionName(flags["--as"]);
    dstSession = flags["--as"];
  } else {
    dstSession = await chooseWakeSessionName(srcWindow);
  }

  // 4. Safety: destination existence (unless --force).
  const dstExists = await hasSessionFn(dstSession);
  if (dstExists && !flags["--force"]) {
    error(`  \x1b[31m✗\x1b[0m promote refused — session '${dstSession}' already exists.`);
    error(`      \x1b[90muse: maw promote ${target} --as <new-name>\x1b[0m`);
    error(`      \x1b[90mor:  maw promote ${target} --force\x1b[0m  (merges into existing)`);
    throw new UserError(`promote: destination '${dstSession}' already exists`);
  }

  async function rollbackCreatedDestination(reason: string): Promise<void> {
    try {
      await killSessionFn(dstSession);
    } catch {
      try {
        await killWindowFn(`${dstSession}:${PROMOTE_PLACEHOLDER}`);
      } catch {
        // Best-effort rollback only; preserve the primary move failure.
      }
    }
    error(`      \x1b[90mrollback: removed placeholder session '${dstSession}' after ${reason}\x1b[0m`);
  }

  // 5. Execute eject.
  let createdDestination = false;
  try {
    if (!dstExists) {
      await newSessionFn(dstSession, { window: PROMOTE_PLACEHOLDER });
      createdDestination = true;
    }
    await runFn("move-window", "-s", srcTarget, "-t", `${dstSession}:`);
  } catch (e: unknown) {
    if (createdDestination) await rollbackCreatedDestination("move-window failure");
    throw new UserError(`promote: tmux move failed — ${e instanceof Error ? e.message : String(e)}`);
  }

  let dstWindows: { name: string }[];
  try {
    dstWindows = await listWindowsFn(dstSession);
  } catch (e: unknown) {
    throw new UserError(
      `promote: tmux move verification failed — cannot list destination session '${dstSession}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!dstWindows.some(w => w.name === srcWindow)) {
    const onlyPlaceholder = dstWindows.length === 0 || dstWindows.every(w => w.name === PROMOTE_PLACEHOLDER);
    if (createdDestination && onlyPlaceholder) {
      await rollbackCreatedDestination("move verification failure");
      throw new UserError(
        `promote: tmux move failed — '${srcTarget}' did not appear in '${dstSession}' after move-window; rolled back placeholder session`,
      );
    }
    throw new UserError(
      `promote: tmux move verification failed — '${srcTarget}' did not appear in '${dstSession}' after move-window`,
    );
  }

  if (createdDestination) {
    try {
      await killWindowFn(`${dstSession}:${PROMOTE_PLACEHOLDER}`);
    } catch {
      // Placeholder may already be auto-cleaned by tmux; safe to ignore.
    }
  }

  // 6. Report (Q5 β+γ — raw tmux undo since `maw take` doesn't exist yet).
  log(`  \x1b[32m✓\x1b[0m promoted — ${srcTarget} → ${dstSession}:${srcWindow}`);
  log(`      \x1b[90m↻ undo: tmux move-window -s ${dstSession}:${srcWindow} -t ${srcSession}:\x1b[0m`);

  // 7. --attach: switch-client only when caller is in tmux (Q4 γ).
  if (flags["--attach"]) {
    if (!callerInTmux()) {
      log(`      \x1b[33m⚠\x1b[0m --attach ignored — caller is not in tmux (use 'maw a ${dstSession}' to attach).`);
    } else {
      try {
        await switchClientFn(dstSession);
      } catch (e: unknown) {
        log(`      \x1b[33m⚠\x1b[0m --attach failed: ${e instanceof Error ? e.message : String(e)}`);
        log(`      \x1b[90mpromote succeeded; switch manually: tmux switch-client -t ${dstSession}\x1b[0m`);
      }
    }
  }
}
