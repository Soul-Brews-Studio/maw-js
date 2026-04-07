import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { listSessions } from "../ssh";
import { tmux } from "../tmux";
import { FLEET_DIR } from "../paths";

/**
 * maw take <oracle>:<window>
 *
 * Vesicle transport — move an active window + worktree ownership
 * from one oracle's session to the current oracle's session.
 */
export async function cmdTake(spec: string): Promise<void> {
  const [sourceOracle, windowHint] = spec.split(":");
  if (!sourceOracle || !windowHint) {
    console.error("usage: maw take <oracle>:<window>");
    console.error("  e.g. maw take neo:dashboard");
    process.exit(1);
  }

  const sessions = await listSessions();

  // Find source session and window
  const sourceSession = sessions.find(s =>
    s.name.endsWith(`-${sourceOracle}`) || s.name === sourceOracle
  );
  if (!sourceSession) {
    console.error(`  \x1b[31m✗\x1b[0m session not found for oracle '${sourceOracle}'`);
    process.exit(1);
  }

  const hintLower = windowHint.toLowerCase();
  const sourceWindow = sourceSession.windows.find(w =>
    w.name.toLowerCase().includes(hintLower)
  );
  if (!sourceWindow) {
    console.error(`  \x1b[31m✗\x1b[0m window '${windowHint}' not found in ${sourceSession.name}`);
    console.error(`  Available: ${sourceSession.windows.map(w => w.name).join(", ")}`);
    process.exit(1);
  }

  // Detect current/target session (the one the user is attached to, or first session)
  let targetSession: string | null = null;
  try {
    const client = await tmux.run("display-message", "-p", "#{client_session}");
    targetSession = client.trim();
  } catch {
    // Fallback: use the first session that isn't the source
    const other = sessions.find(s => s.name !== sourceSession.name);
    targetSession = other?.name || null;
  }

  if (!targetSession || targetSession === sourceSession.name) {
    console.error(`  \x1b[31m✗\x1b[0m cannot take window into the same session`);
    process.exit(1);
  }

  const targetOracle = targetSession.replace(/^\d+-/, "");

  console.log(`\n  \x1b[36m📦 Take\x1b[0m — ${sourceOracle}:${sourceWindow.name} → ${targetOracle}\n`);

  // Move tmux window: unlink from source, link to target
  try {
    await tmux.run("move-window",
      "-s", `${sourceSession.name}:${sourceWindow.name}`,
      "-t", `${targetSession}:`
    );
    console.log(`  \x1b[32m✓\x1b[0m moved window ${sourceWindow.name} → ${targetSession}`);
  } catch (e: any) {
    console.error(`  \x1b[31m✗\x1b[0m tmux move failed: ${e.message || e}`);
    process.exit(1);
  }

  // Update fleet configs: remove from source, add to target
  try {
    let windowConfig: any = null;

    // Remove from source fleet config
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const filePath = join(FLEET_DIR, file);
      const config = JSON.parse(readFileSync(filePath, "utf-8"));
      const idx = (config.windows || []).findIndex((w: any) =>
        w.name.toLowerCase() === sourceWindow.name.toLowerCase()
      );
      if (idx >= 0) {
        windowConfig = config.windows.splice(idx, 1)[0];
        writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m removed from ${file}`);
        break;
      }
    }

    // Add to target fleet config
    if (windowConfig) {
      for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
        const filePath = join(FLEET_DIR, file);
        const config = JSON.parse(readFileSync(filePath, "utf-8"));
        const configName = config.name?.replace(/^\d+-/, "");
        if (configName === targetOracle) {
          config.windows = config.windows || [];
          config.windows.push(windowConfig);
          writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
          console.log(`  \x1b[32m✓\x1b[0m added to ${file}`);
          break;
        }
      }
    }
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m fleet config update failed: ${e.message || e}`);
  }

  console.log(`\n  \x1b[32m📦 Take complete!\x1b[0m ${sourceWindow.name} is now in ${targetSession}\n`);
}
