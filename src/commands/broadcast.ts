import { tmux } from "../tmux";

/**
 * maw broadcast <message> — send to ALL Claude windows across ALL sessions
 * Always prefixes with sender identity so receivers know who broadcasted.
 */
export async function cmdBroadcast(message: string) {
  if (!message) {
    console.error("usage: maw broadcast <message>");
    process.exit(1);
  }

  // Detect sender from current tmux window
  let sender = "unknown";
  try {
    sender = await tmux.run("display-message", "-p", "#{window_name}");
    sender = sender.trim() || "unknown";
  } catch { /* expected: may not be in tmux */ }

  // Prefix message with sender
  message = `[broadcast from ${sender}] ${message}`;

  const sessions = await tmux.listAll();
  let sent = 0;
  let skipped = 0;

  for (const s of sessions) {
    // Skip overview/scratch/view sessions
    if (s.name === "99-overview" || s.name === "scratch") continue;
    if (s.name.endsWith("-view")) continue;

    for (const w of s.windows) {
      const target = `${s.name}:${w.index}`;
      try {
        // Check if window is running claude
        const cmd = await tmux.run("display-message", "-t", target, "-p", "#{pane_current_command}");
        if (!cmd.trim().includes("claude")) {
          skipped++;
          continue;
        }
        await tmux.sendText(target, message);
        console.log(`\x1b[32msent\x1b[0m → ${s.name}:${w.name}`);
        sent++;
      } catch {
        skipped++;
      }
    }
  }

  console.log(`\n\x1b[32m✓\x1b[0m Broadcast to ${sent} windows (${skipped} skipped)`);
}
