import { listSessions } from "../../../sdk";
import { Tmux, tmuxCmd, resolveSocket } from "../../../sdk";
import { loadConfig } from "../../../config";
import { resolveSessionTarget } from "../../../core/matcher/resolve-target";
import { logAnomaly } from "../../../core/fleet/audit";
import { execFileSync } from "child_process";
import { ttyAsk } from "../init/prompts";

/**
 * Decide whether to offer a wake prompt on missing target. Extracted for
 * testability — tests can stub `isTTY` and `wakeFlag` directly.
 *
 * #549 contract:
 *  - --no-wake → never prompt, never wake (back-compat for scripts)
 *  - --wake    → wake unconditionally, no prompt (force opt-in)
 *  - non-TTY   → never prompt (CI/script safety, current behavior)
 *  - TTY       → prompt y/N
 */
export type WakePromptDecision = "skip" | "force" | "ask";
export function decideWakePrompt(opts: {
  isTTY: boolean;
  wake?: boolean;
  noWake?: boolean;
}): WakePromptDecision {
  if (opts.noWake) return "skip";
  if (opts.wake) return "force";
  if (!opts.isTTY) return "skip";
  return "ask";
}

export interface ViewOpts {
  windowHint?: string;
  clean?: boolean;
  kill?: boolean;
  splitAnchor?: string | true;
  wake?: boolean;
  noWake?: boolean;
  /** Test seam: ask user yes/no. Default = ttyAsk via /dev/tty. */
  ask?: (question: string) => Promise<string>;
  /** Test seam: stand-in for cmdWake. Default = real cmdWake. */
  wakeImpl?: (target: string) => Promise<void>;
}

export async function cmdView(
  agent: string,
  windowHintOrOpts?: string | ViewOpts,
  clean = false,
  kill = false,
  splitAnchor?: string | true,
  extraOpts: Pick<ViewOpts, "wake" | "noWake" | "ask" | "wakeImpl"> = {},
) {
  // Backward-compatible signature: callers pass either a windowHint string
  // OR a full ViewOpts object as the second arg.
  let windowHint: string | undefined;
  if (typeof windowHintOrOpts === "object" && windowHintOrOpts !== null) {
    windowHint = windowHintOrOpts.windowHint;
    clean = windowHintOrOpts.clean ?? clean;
    kill = windowHintOrOpts.kill ?? kill;
    splitAnchor = windowHintOrOpts.splitAnchor ?? splitAnchor;
    extraOpts = {
      wake: windowHintOrOpts.wake,
      noWake: windowHintOrOpts.noWake,
      ask: windowHintOrOpts.ask,
      wakeImpl: windowHintOrOpts.wakeImpl,
    };
  } else {
    windowHint = windowHintOrOpts;
  }
  // Find the session
  const sessions = await listSessions();
  const allWindows = sessions.flatMap(s => s.windows.map(w => ({ session: s.name, ...w })));

  // Historic cruft filter for *-view-view sessions created pre-#358.
  // #358 (src/core/fleet/validate.ts) rejects the `-view` suffix at every
  // user-input creation boundary, so new ones can't be made — but *-view-view
  // sessions from earlier alphas still exist on some nodes. Dropping this
  // filter before a fleet-wide sweep re-introduces the alpha.30 ambiguity
  // (confirmed by team-lead on 2026-04-15). Safe to remove after sweep.
  const candidateSessions = sessions.filter(s => !/-view-view$/.test(s.name));

  // Resolve agent → session via canonical matcher (exact > fuzzy > ambiguous > none).
  // Fallback: if no name match, check whether a window name contains the agent
  // (e.g. `maw view foo` hits a window named "foo-work" inside an unrelated session).
  const resolved = resolveSessionTarget(agent, candidateSessions);
  let sessionName: string | null = null;
  if (resolved.kind === "exact" || resolved.kind === "fuzzy") {
    sessionName = resolved.match.name;
  } else if (resolved.kind === "ambiguous") {
    console.error(`  \x1b[31m✗\x1b[0m '${agent}' is ambiguous — matches ${resolved.candidates.length} sessions:`);
    for (const s of resolved.candidates) {
      console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
    }
    console.error(`  \x1b[90m  use the full name: maw view <exact-session>\x1b[0m`);
    throw new Error(`'${agent}' is ambiguous — matches ${resolved.candidates.length} sessions`);
  } else {
    const agentLower = agent.toLowerCase();
    const byWindow = candidateSessions.find(s => s.windows.some(w => w.name.toLowerCase().includes(agentLower)));
    if (byWindow) sessionName = byWindow.name;
  }
  if (!sessionName) {
    // #549 — offer to wake the missing target before erroring out.
    // Decision matrix encoded in decideWakePrompt; see WakePromptDecision.
    //
    // Fleet-known oracles skip the y/N prompt — if the user typed `maw a <x>`
    // and fleet configs pin <x>, we're confident this isn't a typo. Typos
    // (unknown names) still hit the prompt as a guard against accidental wake.
    //
    // #835 — the fleet-known decision is now delegated to the unified
    // shouldAutoWake() helper. View's policy: --wake force / --no-wake skip /
    // fleet-known silent wake / unknown ⇒ caller ask via decideWakePrompt.
    let autoWake = extraOpts.wake;
    if (!autoWake && !extraOpts.noWake) {
      try {
        const { resolveFleetSession } = await import("../../shared/wake-resolve");
        const { shouldAutoWake } = await import("../../shared/should-auto-wake");
        const isFleetKnown = Boolean(resolveFleetSession(agent));
        const decision = shouldAutoWake(agent, {
          site: "view",
          isLive: false, // we already know sessionName is null
          isFleetKnown,
        });
        if (decision.wake) {
          console.log(`\x1b[36m⚡\x1b[0m '${agent}' is fleet-known — auto-wake`);
          autoWake = true;
        }
      } catch { /* fleet check best-effort — fall through to prompt */ }
    }
    const decision = decideWakePrompt({
      isTTY: Boolean(process.stdin.isTTY),
      wake: autoWake,
      noWake: extraOpts.noWake,
    });

    if (decision !== "skip") {
      let proceed = decision === "force";
      if (decision === "ask") {
        const ask = extraOpts.ask ?? ttyAsk;
        try {
          const answer = (await ask(
            `\x1b[36m?\x1b[0m Oracle '${agent}' is not running. Wake it now? [y/N]`,
          )).trim().toLowerCase();
          proceed = answer === "y" || answer === "yes";
        } catch (e) {
          // /dev/tty unavailable — fall through to the existing error.
          proceed = false;
        }
      }

      if (proceed) {
        const wakeImpl =
          extraOpts.wakeImpl ??
          (async (target: string) => {
            const { cmdWake } = await import("../../shared/wake-cmd");
            await cmdWake(target, { attach: true });
          });
        console.log(`\x1b[36m⚡\x1b[0m waking '${agent}'...`);
        await wakeImpl(agent);
        // cmdWake({ attach: true }) handles the attach itself, so we're done.
        return;
      }
    }

    if (resolved.kind === "none" && resolved.hints?.length) {
      console.error(`  \x1b[90mdid you mean:\x1b[0m`);
      for (const h of resolved.hints) {
        console.error(`  \x1b[90m    • ${h.name}\x1b[0m`);
      }
    }
    console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
    throw new Error(`session not found for: ${agent}`);
  }

  const t = new Tmux();
  // #713: with bind/host split, config.host is never a bind address (0.0.0.0 etc.)
  const host = process.env.MAW_HOST || loadConfig().host || "local";
  const isLocal = host === "local" || host === "localhost";
  const socket = resolveSocket();

  // If the resolved session is already a view, attach directly — skip the
  // grouped-session dance that would otherwise create X-view-view.
  if (sessionName.endsWith("-view")) {
    // Resolved to an existing view — attach directly (don't create -view-view stutter)
    if (agent.endsWith("-view")) {
      // User typed the literal view name (re-attach reflex). Log it.
      logAnomaly("view-attach-via-view-name", {
        input: { agent, windowHint, clean },
        context: { resolvedSession: sessionName, action: "attach-existing-view" },
      });
      console.warn(`\x1b[90m  note: '${agent}' is a view session — attaching to existing view (no new session created)\x1b[0m`);
    }
    if (windowHint) {
      const win = allWindows.find(w =>
        w.session === sessionName && (
          w.name === windowHint ||
          w.name.includes(windowHint) ||
          String(w.index) === windowHint
        )
      );
      if (win) {
        await t.selectWindow(`${sessionName}:${win.index}`);
        console.log(`\x1b[36mwindow\x1b[0m  → ${win.name} (${win.index})`);
      } else {
        console.error(`\x1b[33mwarn\x1b[0m: window '${windowHint}' not found, using default`);
      }
    }
    if (clean) {
      await t.set(sessionName, "status", "off");
    }
    if (splitAnchor !== undefined) {
      const { cmdSplit } = await import("../split/impl");
      const anchorPane = typeof splitAnchor === "string"
        ? await resolveAnchorPane(splitAnchor)
        : undefined;
      await cmdSplit(sessionName, { anchorPane });
      return;
    }
    console.log(`\x1b[36mattach\x1b[0m  → ${sessionName}${clean ? " (clean)" : ""}`);
    if (isLocal && process.env.TMUX) {
      await t.switchClient(sessionName);
      console.log(
        `\x1b[90mhint\x1b[0m    → detach with prefix+d, then \`tmux kill-session -t ${sessionName}\` when done`,
      );
      return;
    }
    try {
      attachViaTmux({ isLocal, socket, host, target: sessionName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[33mwarn\x1b[0m: attach exited non-zero — ${msg}`);
    }
    // We did NOT create this session, so we do NOT kill it on cleanup.
    return;
  }

  // Generate view name from RESOLVED session (not raw input) — prevents duplicates
  // e.g. "maw a worm" and "maw a wormhole" both resolve to "102-white-wormhole"
  // and should reuse the same view session instead of creating worm-view + wormhole-view
  const viewBase = sessionName.replace(/^\d+-/, "");
  const viewName = `${viewBase}-view${windowHint ? `-${windowHint}` : ""}`;

  // Reuse existing view if present — killing it would evict anyone else
  // already attached (e.g. a second terminal on the same view).
  const viewExists = await t.hasSession(viewName);
  if (!viewExists) {
    await t.newGroupedSession(sessionName, viewName, { windowSize: "largest" });
    console.log(`\x1b[36mcreated\x1b[0m → ${viewName} (grouped with ${sessionName})`);
  } else {
    console.log(`\x1b[36mreuse\x1b[0m   → ${viewName} (existing grouped session — ${sessionName})`);
  }

  // Select specific window if requested
  if (windowHint) {
    const win = allWindows.find(w =>
      w.session === sessionName && (
        w.name === windowHint ||
        w.name.includes(windowHint) ||
        String(w.index) === windowHint
      )
    );
    if (win) {
      await t.selectWindow(`${viewName}:${win.index}`);
      console.log(`\x1b[36mwindow\x1b[0m  → ${win.name} (${win.index})`);
    } else {
      console.error(`\x1b[33mwarn\x1b[0m: window '${windowHint}' not found, using default`);
    }
  }

  // Hide status bar if --clean
  if (clean) {
    await t.set(viewName, "status", "off");
  }

  // --split[=<anchor>]: open the view in a new tmux pane instead of
  // detaching+attaching the whole client. Explicit anchor breaks the
  // active-pane-drift that caused the fractal-split cascade (#545/#546).
  if (splitAnchor !== undefined) {
    const { cmdSplit } = await import("../split/impl");
    const anchorPane = typeof splitAnchor === "string"
      ? await resolveAnchorPane(splitAnchor)
      : undefined;
    await cmdSplit(viewName, { anchorPane });
    return;
  }

  // Attach interactively
  console.log(`\x1b[36mattach\x1b[0m  → ${viewName}${clean ? " (clean)" : ""}`);

  // Already inside tmux? switch-client is the only option — nested
  // `attach-session` would fail with "sessions should be nested with care".
  // Fire-and-forget: we can't block until the user detaches, so we skip the
  // automatic kill-session cleanup and print a hint instead.
  if (isLocal && process.env.TMUX) {
    await t.switchClient(viewName);
    console.log(
      `\x1b[90mhint\x1b[0m    → detach with prefix+d, then \`tmux kill-session -t ${viewName}\` when done`,
    );
    return;
  }

  // Use execFileSync (not Bun.spawn) for the blocking attach — Bun.spawn with
  // stdin:"inherit" has TTY handoff issues that can propagate SIGHUP up to
  // the parent SSH session when tmux detaches, closing the whole terminal.
  // execFileSync + stdio:"inherit" matches the proven pattern in wake.ts
  // (attachToSession helper, e07b7e9). argv form avoids local shell
  // interpretation of session names (js/indirect-command-line-injection, #474).
  try {
    attachViaTmux({ isLocal, socket, host, target: viewName });
  } catch (err) {
    // tmux exits non-zero when attach fails (session gone, socket missing,
    // etc). Log but do NOT re-throw — a failed attach should not cascade
    // into process.exit(1) that might take the SSH session with it.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[33mwarn\x1b[0m: attach exited non-zero — ${msg}`);
  }

  // #420: no auto-cleanup on detach. The view is grouped (shares state with
  // the oracle session), so keeping it idle is cheap — and killing it here
  // forces the next `maw a <agent>` to pay the create cost again. Stale
  // views are reaped by `maw cleanup --zombie-agents` (#400/#418) or by
  // explicit `--kill` on this command.
  if (kill) {
    await t.killSession(viewName);
    console.log(`\x1b[90mcleaned\x1b[0m → ${viewName}`);
  }
}

/**
 * Resolve a `--split=<anchor>` argument to a tmux pane selector for cmdSplit.
 *   - "session:window"  → passed through (tmux resolves to that window's active pane)
 *   - bare name         → find <name>-view; auto-bootstrap via newGroupedSession
 *                         if it doesn't exist yet; return "<name>-view:0"
 */
async function resolveAnchorPane(anchor: string): Promise<string> {
  if (anchor.includes(":")) return anchor;
  const t = new Tmux();
  const viewName = `${anchor.replace(/-view$/, "")}-view`;
  if (!(await t.hasSession(viewName))) {
    const sessions = await listSessions();
    const candidates = sessions.filter(
      s => !/-view$/.test(s.name) && !/-view-view$/.test(s.name),
    );
    const r = resolveSessionTarget(anchor, candidates);
    if (r.kind !== "exact" && r.kind !== "fuzzy") {
      throw new Error(`--split=${anchor}: no matching session or existing view`);
    }
    await t.newGroupedSession(r.match.name, viewName, { windowSize: "largest" });
  }
  return `${viewName}:0`;
}

// Reject tmux session names that contain anything a remote shell could parse.
// Tmux itself accepts only a restricted set, and our fleet validators
// (src/core/fleet/validate.ts) tighten that further — but defense in depth
// protects the ssh branch, where the remote command is shell-interpreted.
const SAFE_SESSION_NAME = /^[A-Za-z0-9._-]+$/;

function attachViaTmux(opts: {
  isLocal: boolean;
  socket: string | undefined;
  host: string;
  target: string;
}): void {
  const { isLocal, socket, host, target } = opts;
  if (isLocal) {
    const args = socket
      ? ["-S", socket, "attach-session", "-t", target]
      : ["attach-session", "-t", target];
    execFileSync("tmux", args, { stdio: "inherit" });
    return;
  }
  if (!SAFE_SESSION_NAME.test(target)) {
    throw new Error(`refusing ssh attach: unsafe session name '${target}'`);
  }
  const remoteCmd = `${tmuxCmd()} attach-session -t '${target}'`;
  execFileSync("ssh", ["-tt", host, remoteCmd], { stdio: "inherit" });
}
