import { listSessions } from "../ssh";
import { Tmux, tmuxCmd, resolveSocket } from "../tmux";
import { loadConfig } from "../config";
import { execSync } from "child_process";

export async function cmdView(agent: string, windowHint?: string, clean = false) {
  // Find the session
  const sessions = await listSessions();
  const allWindows = sessions.flatMap(s => s.windows.map(w => ({ session: s.name, ...w })));

  // Resolve agent → session (case-insensitive)
  const agentLower = agent.toLowerCase();
  let sessionName: string | null = null;
  for (const s of sessions) {
    const sLower = s.name.toLowerCase();
    if (sLower.endsWith(`-${agentLower}`) || sLower === agentLower) { sessionName = s.name; break; }
    if (s.windows.some(w => w.name.toLowerCase().includes(agentLower))) { sessionName = s.name; break; }
  }
  if (!sessionName) { console.error(`session not found for: ${agent}`); process.exit(1); }

  // Generate unique view name
  const viewName = `${agent}-view${windowHint ? `-${windowHint}` : ""}`;

  // Kill existing view with same name
  const t = new Tmux();
  await t.killSession(viewName);

  // Create grouped session
  await t.newGroupedSession(sessionName, viewName, { cols: 200, rows: 50 });
  console.log(`\x1b[36mcreated\x1b[0m → ${viewName} (grouped with ${sessionName})`);

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
  const host = process.env.MAW_HOST || loadConfig().host || "local";
  const isLocal = host === "local" || host === "localhost";
  const socket = resolveSocket();
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

  // Cleanup: kill grouped session after detach (or after failed attach)
  await t.killSession(viewName);
  console.log(`\x1b[90mcleaned\x1b[0m → ${viewName}`);
  // Normal return — no process.exit. Letting the event loop drain naturally
  // is safer than forcing an exit code that can race with parent shell state.
}
