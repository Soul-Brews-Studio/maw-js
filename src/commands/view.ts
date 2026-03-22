import { listSessions } from "../ssh";
import { Tmux, tmuxCmd, resolveSocket } from "../tmux";
import { loadConfig } from "../config";

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
  const host = process.env.MAW_HOST || loadConfig().host || "white.local";
  const isLocal = host === "local" || host === "localhost";
  const socket = resolveSocket();
  const attachArgs = isLocal
    ? (socket ? ["tmux", "-S", socket, "attach-session", "-t", viewName]
              : ["tmux", "attach-session", "-t", viewName])
    : ["ssh", "-tt", host, `${tmuxCmd()} attach-session -t '${viewName}'`];
  console.log(`\x1b[36mattach\x1b[0m  → ${viewName}${clean ? " (clean)" : ""}`);
  const proc = Bun.spawn(attachArgs, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;

  // Cleanup: kill grouped session after detach
  await t.killSession(viewName);
  console.log(`\x1b[90mcleaned\x1b[0m → ${viewName}`);
  process.exit(exitCode);
}
