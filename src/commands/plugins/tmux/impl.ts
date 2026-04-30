import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hostExec, tmux } from "../../../sdk";
import { resolveSessionTarget } from "../../../core/matcher/resolve-target";
import { loadFleetEntries } from "../../shared/fleet-load";
import { ghqList } from "../../../core/ghq";
import { scanWorktrees } from "../../../core/fleet/worktrees-scan";
import { checkDestructive, isClaudeLikePane, isFleetOrViewSession } from "./safety";

const TEAMS_DIR = join(homedir(), ".claude/teams");

// #971 — process.stdout.isTTY is `undefined` (not false) in bun-bundled
// binaries installed via curl. `!!undefined` → false, making attach always
// fall to print-only. node:tty.isatty(1) checks the fd directly and works
// in both source and bundled contexts. Wrapped in object for test mockability
// (ES module namespace objects are frozen, bare `let` can't be reassigned).
export const _tty = {
  isStdoutTTY: (): boolean => {
    try {
      const { isatty } = require("node:tty") as typeof import("node:tty");
      return isatty(1);
    } catch {
      return !!process.stdout.isTTY;
    }
  },
};

export interface TmuxPeekOpts {
  /** Number of lines from bottom of pane buffer. Default 30. */
  lines?: number;
  /** Include full scrollback (-S -). Overrides --lines. */
  history?: boolean;
}

/**
 * Resolve a user-supplied target into a tmux pane identifier suitable for
 * `tmux capture-pane -pt <id>`.
 *
 * Resolution order:
 *   1. Pane ID literal (e.g. "%776")
 *   2. Fully-qualified session:w.p (e.g. "101-mawjs:0.1")
 *   3. Team agent name → walk ~/.claude/teams/* /config.json, find member
 *   4. Bare session name → <target>:0 (pane 0)
 *
 * Returns the resolved target and a human-readable "how I found it" note.
 */
export function resolveTmuxTarget(target: string): { resolved: string; source: string } | null {
  // 1. Pane ID
  if (/^%\d+$/.test(target)) return { resolved: target, source: "pane-id" };

  // 2. session:w.p
  if (/^[\w.-]+:\d+\.\d+$/.test(target)) return { resolved: target, source: "session:w.p" };

  // 3. Team agent name — walk team configs
  if (existsSync(TEAMS_DIR)) {
    for (const dir of readdirSync(TEAMS_DIR)) {
      const cfg = join(TEAMS_DIR, dir, "config.json");
      if (!existsSync(cfg)) continue;
      try {
        const team = JSON.parse(readFileSync(cfg, "utf-8"));
        for (const m of team.members ?? []) {
          if (m?.name === target && m?.tmuxPaneId && m.tmuxPaneId !== "" && m.tmuxPaneId !== "in-process") {
            return { resolved: m.tmuxPaneId, source: `team-agent (${dir})` };
          }
        }
      } catch { /* skip bad config */ }
    }
  }

  // 3.5 — Fleet session by bare stem (#394 Bug I). e.g. "mawjs-no2" → "114-mawjs-no2:0".
  // Matches maw peek's resolution. Suffix-preferred via the canonical
  // resolveSessionTarget so "mawjs" → "101-mawjs" (not "mawjs-view").
  try {
    const sessions = loadFleetEntries().map(e => ({ name: e.file.replace(/\.json$/, "") }));
    const r = resolveSessionTarget(target, sessions);
    if (r.kind === "exact" || r.kind === "fuzzy") {
      return { resolved: `${r.match.name}:0`, source: `fleet-stem (${r.match.name})` };
    }
  } catch { /* no fleet dir — fall through */ }

  // 4. Bare session name → pane 0
  return { resolved: `${target}:0`, source: "session-name (pane 0)" };
}

export async function cmdTmuxPeek(target: string, opts: TmuxPeekOpts = {}): Promise<void> {
  const hit = resolveTmuxTarget(target);
  if (!hit) {
    throw new Error(`cannot resolve target '${target}'`);
  }

  const { resolved, source } = hit;
  const lines = opts.lines ?? 30;
  const scroll = opts.history ? "-S -" : `-S -${lines}`;

  let out: string;
  try {
    out = await hostExec(`tmux capture-pane -pt '${resolved}' ${scroll} -J`);
  } catch (e: any) {
    throw new Error(`tmux capture-pane failed for '${resolved}' (from ${source}): ${e?.message || e}`);
  }

  console.log(`\x1b[90m▸ ${target} → ${resolved} [${source}]\x1b[0m`);
  console.log(out);
}

export interface TmuxLsOpts {
  /** Include every pane across every session (tmux list-panes -a). Default: current session only. */
  all?: boolean;
  /** JSON output for scripting. */
  json?: boolean;
  /** Compact: one line per session. Default for `maw ls`. Use -v for full detail. */
  compact?: boolean;
  /** Verbose: full per-pane detail. Overrides --compact. */
  verbose?: boolean;
  /** Roster: include sleeping oracles from ghq (compact mode only). */
  roster?: boolean;
}

export type PaneStatus = "active" | "idle" | "stale" | "unknown";

interface AnnotatedPane {
  id: string;
  target: string;
  command: string | undefined;
  title: string | undefined;
  annotation: string; // "fleet: X" | "team: agent @ team-name" | "orphan" | ""
  status: PaneStatus;
  lastActivitySec: number;
}

/**
 * List tmux panes with fleet + team annotations. Supersedes `maw panes`
 * with smarter labeling — if a pane is a fleet oracle or a team agent,
 * say so explicitly so operators don't need to cross-check configs.
 */
export async function cmdTmuxLs(opts: TmuxLsOpts = {}): Promise<void> {
  const allPanes = await tmux.listPanes();
  const currentSession = process.env.TMUX
    ? (await hostExec("tmux display-message -p '#{session_name}'").catch(() => "")).trim()
    : "";

  // Fleet sessions for annotation
  const fleetSessions = new Set<string>();
  try {
    for (const entry of loadFleetEntries()) {
      fleetSessions.add(entry.file.replace(/\.json$/, ""));
    }
  } catch { /* no fleet dir */ }

  // Team members for annotation: pane_id → "agent @ team-name"
  const teamByPane = new Map<string, string>();
  if (existsSync(TEAMS_DIR)) {
    for (const dir of readdirSync(TEAMS_DIR)) {
      const cfg = join(TEAMS_DIR, dir, "config.json");
      if (!existsSync(cfg)) continue;
      try {
        const team = JSON.parse(readFileSync(cfg, "utf-8"));
        for (const m of team.members ?? []) {
          if (m?.tmuxPaneId && m.tmuxPaneId !== "" && m.tmuxPaneId !== "in-process") {
            teamByPane.set(m.tmuxPaneId, `${m.name} @ ${dir}`);
          }
        }
      } catch { /* skip bad config */ }
    }
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const annotated: AnnotatedPane[] = allPanes.map(p => {
    const ageSec = p.lastActivity ? nowEpoch - p.lastActivity : -1;
    const status: PaneStatus = ageSec < 0 ? "unknown" : ageSec < 30 ? "active" : ageSec < 300 ? "idle" : "stale";
    return {
      id: p.id,
      target: p.target,
      command: p.command,
      title: p.title,
      annotation: annotatePane(p, fleetSessions, teamByPane),
      status,
      lastActivitySec: ageSec < 0 ? 0 : ageSec,
    };
  });

  const scope = opts.all
    ? annotated
    : annotated.filter(p => p.target.startsWith(`${currentSession}:`));

  if (opts.json) {
    console.log(JSON.stringify(scope, null, 2));
    return;
  }

  if (!scope.length && !(opts.compact && opts.roster)) {
    console.log(opts.all
      ? "\x1b[90mNo panes found.\x1b[0m"
      : `\x1b[90mNo panes in current session '${currentSession || "(none)"}'. Use --all for every session.\x1b[0m`);
    return;
  }

  const STATUS_DOT: Record<PaneStatus, string> = {
    active: "\x1b[32m●\x1b[0m",
    idle: "\x1b[33m◐\x1b[0m",
    stale: "\x1b[31m◌\x1b[0m",
    unknown: "\x1b[90m·\x1b[0m",
  };

  const formatAge = (sec: number): string => {
    if (sec <= 0) return "";
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  };

  if (opts.compact && !opts.verbose) {
    const bySession = new Map<string, AnnotatedPane[]>();
    for (const p of scope) {
      const sess = p.target.split(":")[0]!;
      if (!bySession.has(sess)) bySession.set(sess, []);
      bySession.get(sess)!.push(p);
    }
    const bestStatus = (panes: AnnotatedPane[]): PaneStatus => {
      if (panes.some(p => p.status === "active")) return "active";
      if (panes.some(p => p.status === "idle")) return "idle";
      if (panes.some(p => p.status === "stale")) return "stale";
      return "unknown";
    };
    let worktrees: Awaited<ReturnType<typeof scanWorktrees>> = [];
    try { worktrees = await scanWorktrees(); } catch { /* non-critical */ }
    const wtBySession = new Map<string, typeof worktrees>();
    for (const wt of worktrees) {
      const mainName = wt.mainRepo.split("/").pop() || "";
      if (!wtBySession.has(mainName)) wtBySession.set(mainName, []);
      wtBySession.get(mainName)!.push(wt);
    }

    console.log();
    const awakeNames = new Set<string>();
    for (const [sess, panes] of bySession) {
      awakeNames.add(sess);
      const dot = STATUS_DOT[bestStatus(panes)];
      const count = `${panes.length} pane${panes.length !== 1 ? "s" : ""}`;
      const agents = panes.filter(p => /claude|node/i.test(p.command || "")).length;
      const agentTag = agents > 0 ? `  \x1b[34m${agents} agent${agents !== 1 ? "s" : ""}\x1b[0m` : "";
      console.log(`  ${dot} \x1b[36m${sess}\x1b[0m  \x1b[90m${count}\x1b[0m${agentTag}`);
      const wts = wtBySession.get(sess) || [];
      for (const wt of wts) {
        const wtDot = wt.status === "active" ? "\x1b[32m├─\x1b[0m" : "\x1b[90m├─\x1b[0m";
        const label = wt.status === "orphan" ? "orphan" : wt.status === "stale" ? "stale" : "worktree";
        console.log(`    ${wtDot} \x1b[90m${wt.name}  (${label})\x1b[0m`);
      }
    }

    if (opts.roster) {
      try {
        const repos = await ghqList();
        const sleeping = repos
          .filter(p => p.endsWith("-oracle"))
          .map(p => p.split("/").pop()!)
          .filter(name => !awakeNames.has(name))
          .sort();
        for (const name of sleeping) {
          console.log(`  \x1b[90m· ${name}  (sleeping)\x1b[0m`);
        }
        const total = awakeNames.size + sleeping.length;
        if (sleeping.length > 0) {
          console.log();
          console.log(`\x1b[90m  ${total} oracles — ${awakeNames.size} awake, ${sleeping.length} sleeping\x1b[0m`);
        }
      } catch { /* ghq unavailable */ }
    }

    console.log();
    console.log(`\x1b[90m  → maw ls -v     full detail\x1b[0m`);
    console.log();
    return;
  }

  console.log();
  console.log(`  \x1b[36;1m  ${pad("TARGET", 28)} ${pad("CMD", 10)} ${pad("AGE", 6)} ${pad("ANNOTATION", 30)} TITLE\x1b[0m`);
  for (const p of scope) {
    const dot = STATUS_DOT[p.status];
    const age = formatAge(p.lastActivitySec);
    const annColored = p.annotation.startsWith("team:") ? `\x1b[36m${p.annotation}\x1b[0m`
      : p.annotation.startsWith("fleet:") ? `\x1b[32m${p.annotation}\x1b[0m`
      : p.annotation.startsWith("view:") ? `\x1b[90m${p.annotation}\x1b[0m`
      : p.annotation === "orphan" ? `\x1b[33morphan\x1b[0m`
      : "";
    const annPad = pad(p.annotation, 30);
    const annRendered = annColored ? annColored + annPad.slice(p.annotation.length) : annPad;
    console.log(`  ${dot} ${pad(p.target, 28)} ${pad(p.command || "", 10)} ${pad(age, 6)} ${annRendered} \x1b[90m${(p.title || "").slice(0, 50)}\x1b[0m`);
  }
  console.log();
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export interface TmuxSendOpts {
  /** Append Enter after the command. Default true. Use --literal for raw keystrokes. */
  literal?: boolean;
  /** Bypass destructive-pattern deny-list. Required for rm/sudo/redirect/etc. */
  allowDestructive?: boolean;
  /** Bypass claude-pane refusal. Required to inject into a live claude session. */
  force?: boolean;
}

// ❤️ Heartbeat #974 — per-pane cooldown + quota tracking.
// Prevents rapid-fire send-keys spam from stale agent turns.
export const _sendTracker = new Map<string, { lastTs: number; count: number; windowStart: number }>();
const COOLDOWN_MS = 500;
const QUOTA_PER_MINUTE = 100;
const QUOTA_WINDOW_MS = 60_000;

/**
 * Send a command into a target tmux pane. Wraps `tmux send-keys` with
 * three safety gates:
 *
 *   1. Destructive-command deny-list (unless --allow-destructive)
 *   2. Refuse if pane is running a claude-like process (unless --force)
 *   3. Pane existence check before sending
 *
 * Default appends Enter (Enter key after the literal); --literal sends
 * the keys verbatim (useful for keystroke chains, escape sequences).
 */
export async function cmdTmuxSend(target: string, command: string, opts: TmuxSendOpts = {}): Promise<void> {
  if (!command) {
    throw new Error("usage: maw tmux send <target> <command> [--literal] [--allow-destructive] [--force]");
  }

  const hit = resolveTmuxTarget(target);
  if (!hit) throw new Error(`cannot resolve target '${target}'`);
  const { resolved, source } = hit;

  // Gate 0 — cooldown + quota (Heartbeat #974)
  if (!opts.force) {
    const now = Date.now();
    const prev = _sendTracker.get(resolved);
    if (prev) {
      if (now - prev.lastTs < COOLDOWN_MS) {
        console.warn(`\x1b[33m⚠\x1b[0m send throttled: ${target} → cooldown (${COOLDOWN_MS}ms). Use --force to bypass.`);
        return;
      }
      if (now - prev.windowStart > QUOTA_WINDOW_MS) {
        prev.count = 0;
        prev.windowStart = now;
      }
      if (prev.count >= QUOTA_PER_MINUTE) {
        console.warn(`\x1b[33m⚠\x1b[0m send throttled: ${target} → quota (${QUOTA_PER_MINUTE}/min). Use --force to bypass.`);
        return;
      }
      prev.lastTs = now;
      prev.count++;
    } else {
      _sendTracker.set(resolved, { lastTs: now, count: 1, windowStart: now });
    }
  }

  // Gate 1 — destructive-command deny-list
  const destCheck = checkDestructive(command);
  if (destCheck.destructive && !opts.allowDestructive) {
    throw new Error(
      `refusing to send: command matches destructive patterns:\n` +
      destCheck.reasons.map(r => `  - ${r}`).join("\n") +
      `\n  pass --allow-destructive to bypass (review carefully first)`
    );
  }

  // Gate 2 — refuse if target pane is running claude (would inject into a live AI turn)
  let paneCurrentCommand: string | undefined;
  try {
    const out = await hostExec(`tmux display-message -p -t '${resolved}' '#{pane_current_command}'`);
    paneCurrentCommand = out.trim();
  } catch (e: any) {
    throw new Error(`pane lookup failed for '${resolved}' (from ${source}): ${e?.message || e}`);
  }
  if (isClaudeLikePane(paneCurrentCommand) && !opts.force) {
    throw new Error(
      `refusing to send: pane '${resolved}' is running '${paneCurrentCommand}' (claude-like).\n` +
      `  injecting keys would collide with the AI's turn.\n` +
      `  pass --force to override (you really want to type into a live claude pane)`
    );
  }

  // Send
  const args = opts.literal
    ? `tmux send-keys -t '${resolved}' '${command.replace(/'/g, "'\\''")}'`
    : `tmux send-keys -t '${resolved}' '${command.replace(/'/g, "'\\''")}' Enter`;

  try {
    await hostExec(args);
  } catch (e: any) {
    throw new Error(`send-keys failed for '${resolved}': ${e?.message || e}`);
  }

  console.log(`\x1b[32m✓\x1b[0m sent to ${target} → ${resolved} \x1b[90m[${source}]${opts.literal ? " (literal)" : ""}${opts.allowDestructive ? " (destructive-allowed)" : ""}${opts.force ? " (force)" : ""}\x1b[0m`);
}

export interface TmuxSplitOpts {
  /** Vertical (stacked) split. Default horizontal (side-by-side). */
  vertical?: boolean;
  /** Size percent for the new pane (1-99). Default 50. */
  pct?: number;
  /** Command to run in the new pane. Default: login shell. */
  cmd?: string;
}

/**
 * Split a target pane. Wraps `tmux split-window -t <target>`. Thin —
 * intentionally NOT delegating to the maw split plugin (that one
 * attaches to a fleet session; this one is a primitive split).
 */
export async function cmdTmuxSplit(target: string, opts: TmuxSplitOpts = {}): Promise<void> {
  const hit = resolveTmuxTarget(target);
  if (!hit) throw new Error(`cannot resolve target '${target}'`);
  const { resolved, source } = hit;

  const pct = opts.pct ?? 50;
  if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
    throw new Error(`--pct must be 1-99 (got ${pct})`);
  }

  const direction = opts.vertical ? "-v" : "-h";
  const cmdSuffix = opts.cmd ? ` '${opts.cmd.replace(/'/g, "'\\''")}'` : "";
  const tmuxCmd = `tmux split-window ${direction} -l ${pct}% -t '${resolved}'${cmdSuffix}`;

  try {
    await hostExec(tmuxCmd);
  } catch (e: any) {
    throw new Error(`split-window failed for '${resolved}' (from ${source}): ${e?.message || e}`);
  }

  console.log(`\x1b[32m✓\x1b[0m split ${target} → ${resolved} \x1b[90m[${source}] ${opts.vertical ? "vertical" : "horizontal"} ${pct}%\x1b[0m`);
}

export interface TmuxKillOpts {
  /** Bypass fleet/view session refusal. Required to kill a live oracle pane/session. */
  force?: boolean;
  /** Kill the entire session (not just the pane). */
  session?: boolean;
}

/**
 * Kill a target pane or session. Wraps `tmux kill-pane -t` or
 * `tmux kill-session -t`. Refuses fleet/view sessions by default
 * (Bug F class — never accidentally kill live oracles).
 */
export async function cmdTmuxKill(target: string, opts: TmuxKillOpts = {}): Promise<void> {
  const hit = resolveTmuxTarget(target);
  if (!hit) throw new Error(`cannot resolve target '${target}'`);
  const { resolved, source } = hit;

  // Fleet/view safety — extract session from resolved target
  const session = resolved.split(":")[0] ?? "";
  const fleetSessions = new Set<string>();
  try {
    for (const entry of loadFleetEntries()) {
      fleetSessions.add(entry.file.replace(/\.json$/, ""));
    }
  } catch { /* no fleet dir */ }

  if (isFleetOrViewSession(session, fleetSessions) && !opts.force) {
    throw new Error(
      `refusing to kill: session '${session}' is fleet or view.\n` +
      `  killing would terminate a live oracle (or its mirror).\n` +
      `  pass --force to override (you really want to kill a fleet session)`
    );
  }

  const tmuxCmd = opts.session
    ? `tmux kill-session -t '${session}'`
    : `tmux kill-pane -t '${resolved}'`;

  try {
    await hostExec(tmuxCmd);
  } catch (e: any) {
    throw new Error(`kill failed for '${resolved}' (from ${source}): ${e?.message || e}`);
  }

  console.log(`\x1b[32m✓\x1b[0m killed ${opts.session ? "session" : "pane"} ${target} → ${opts.session ? session : resolved} \x1b[90m[${source}]${opts.force ? " (force)" : ""}\x1b[0m`);
}

export interface TmuxLayoutOpts {
  preset: string;
}

const VALID_LAYOUTS = ["even-horizontal", "even-vertical", "main-horizontal", "main-vertical", "tiled"] as const;

/**
 * Apply a layout preset to a window. Wraps `tmux select-layout -t <window> <preset>`.
 */
export async function cmdTmuxLayout(target: string, preset: string): Promise<void> {
  if (!VALID_LAYOUTS.includes(preset as any)) {
    throw new Error(`invalid layout '${preset}'. Valid: ${VALID_LAYOUTS.join(", ")}`);
  }
  const hit = resolveTmuxTarget(target);
  if (!hit) throw new Error(`cannot resolve target '${target}'`);
  const { resolved, source } = hit;

  // Layouts apply to windows, not panes — strip pane index if present
  const window = resolved.replace(/\.\d+$/, "");

  try {
    await hostExec(`tmux select-layout -t '${window}' ${preset}`);
  } catch (e: any) {
    throw new Error(`select-layout failed for '${window}' (from ${source}): ${e?.message || e}`);
  }

  console.log(`\x1b[32m✓\x1b[0m layout ${preset} applied to ${target} → ${window} \x1b[90m[${source}]\x1b[0m`);
}

export interface TmuxAttachOpts {
  /** Force print-only mode (no exec) regardless of TTY/$TMUX state. */
  print?: boolean;
}

/**
 * Attach to a tmux session.
 *
 * Branch behavior (issue #962, fix for #395 print-only regression):
 *   - Inside tmux ($TMUX set) + TTY → `tmux switch-client -t <session>`
 *   - Outside tmux + TTY            → `tmux attach -t <session>`
 *   - No TTY (script/pipe/CI)       → fall back to 3-line print (don't break automation)
 *   - Explicit --print              → force print mode regardless of TTY
 *
 * Pre-#962 this was print-only (since #395, 2026-04-17). RFC #954's `a`
 * alias surfaced the regression — operators expected `maw a foo` to attach,
 * not just print instructions.
 */
export function cmdTmuxAttach(target: string, opts: TmuxAttachOpts = {}): void {
  const hit = resolveTmuxTarget(target);
  if (!hit) throw new Error(`cannot resolve target '${target}'`);
  const { resolved, source } = hit;
  const session = resolved.split(":")[0] ?? "";

  const isTty = _tty.isStdoutTTY();
  const inTmux = !!process.env.TMUX;

  if (opts.print || !isTty) {
    console.log(`\x1b[36mRun:\x1b[0m tmux attach -t ${session}`);
    console.log(`\x1b[90m  resolved: ${target} → ${session} [${source}]`);
    console.log(`  detach with: Ctrl-b d\x1b[0m`);
    return;
  }

  const tmuxArgs = inTmux
    ? ["switch-client", "-t", session]
    : ["attach", "-t", session];
  const verb = inTmux ? "switch-client" : "attach";

  const result = Bun.spawnSync(["tmux", ...tmuxArgs], {
    stdio: ["inherit", "inherit", "inherit"],
  });

  if (result.exitCode !== 0) {
    throw new Error(`tmux ${verb} failed (exit ${result.exitCode}) for session '${session}' [${source}]`);
  }
}

/**
 * Pure annotation logic — given a pane + fleet session names + a team
 * lookup map, return the one-line label for the "ANNOTATION" column.
 * Exported for unit test.
 *
 * Precedence: team > fleet > view > orphan (claude-only) > "".
 */
export function annotatePane(
  p: { id: string; target: string; command?: string },
  fleetSessions: Set<string>,
  teamByPane: Map<string, string>,
): string {
  const session = p.target.split(":")[0] ?? "";
  const team = teamByPane.get(p.id);
  if (team) return `team: ${team}`;
  if (fleetSessions.has(session)) return `fleet: ${session.replace(/^\d+-/, "")}`;
  if (session === "maw-view" || /-view$/.test(session)) return `view: ${session}`;
  if (p.command?.includes("claude")) return "orphan";
  return "";
}
