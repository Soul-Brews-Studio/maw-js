import { listSessions } from "../../../sdk";
import { Tmux, tmuxCmd, resolveSocket } from "../../../sdk";
import { loadConfig } from "../../../config";
import { resolveSessionTarget } from "../../../core/matcher/resolve-target";
import { logAnomaly } from "../../../core/fleet/audit";
import { execSync } from "child_process";

export async function cmdView(agent: string, windowHint?: string, clean = false) {
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
    console.log(`\x1b[36mattach\x1b[0m  → ${sessionName}${clean ? " (clean)" : ""}`);
    if (isLocal && process.env.TMUX) {
      await t.switchClient(sessionName);
      console.log(
        `\x1b[90mhint\x1b[0m    → detach with prefix+d, then \`tmux kill-session -t ${sessionName}\` when done`,
      );
      return;
    }
    const directCmd = isLocal
      ? socket
        ? `tmux -S ${socket} attach-session -t ${sessionName}`
        : `tmux attach-session -t ${sessionName}`
      : `ssh -tt ${host} "${tmuxCmd()} attach-session -t '${sessionName}'"`;
    try {
      execSync(directCmd, { stdio: "inherit" });
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
  let weCreated = false;
  if (!viewExists) {
    await t.newGroupedSession(sessionName, viewName, { windowSize: "largest" });
    console.log(`\x1b[36mcreated\x1b[0m → ${viewName} (grouped with ${sessionName})`);
    weCreated = true;
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

  // Use execSync (not Bun.spawn) for the blocking attach — Bun.spawn with
  // stdin:"inherit" has TTY handoff issues that can propagate SIGHUP up to
  // the parent SSH session when tmux detaches, closing the whole terminal.
  // execSync + stdio:"inherit" matches the proven pattern in wake.ts
  // (attachToSession helper, e07b7e9).
  const attachCmd = isLocal
    ? socket
      ? `tmux -S ${socket} attach-session -t ${viewName}`
      : `tmux attach-session -t ${viewName}`
    : `ssh -tt ${host} "${tmuxCmd()} attach-session -t '${viewName}'"`;

  try {
    execSync(attachCmd, { stdio: "inherit" });
  } catch (err) {
    // tmux exits non-zero when attach fails (session gone, socket missing,
    // etc). Log but do NOT re-throw — a failed attach should not cascade
    // into process.exit(1) that might take the SSH session with it.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[33mwarn\x1b[0m: attach exited non-zero — ${msg}`);
  }

  // Cleanup: kill grouped session after detach (or after failed attach) — but
  // only if WE created it. A reused view may have other attached clients.
  if (weCreated) {
    await t.killSession(viewName);
    console.log(`\x1b[90mcleaned\x1b[0m → ${viewName}`);
  }
  // Normal return — no process.exit. Letting the event loop drain naturally
  // is safer than forcing an exit code that can race with parent shell state.
}
