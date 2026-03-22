import { ssh } from "../ssh";
import { tmux, tmuxCmd } from "../tmux";
import { cmdPeek, cmdSend } from "./comm";
import { cmdTalkTo } from "./talk-to";

/**
 * Get current tmux session name (whoami).
 * Uses tmux display-message which returns the session of the calling terminal.
 */
async function currentSession(): Promise<string> {
  try {
    return (await tmux.run("display-message", "-p", "#S")).trim();
  } catch {
    console.error("\x1b[31merror\x1b[0m: not inside a tmux session");
    process.exit(1);
  }
}

/**
 * List windows in current session, mapping index → name.
 */
async function listTabs(session: string): Promise<{ index: number; name: string; active: boolean }[]> {
  const raw = await ssh(
    `${tmuxCmd()} list-windows -t '${session}' -F '#{window_index}:#{window_name}:#{window_active}'`
  );
  return raw.split("\n").filter(Boolean).map(line => {
    const [idx, name, active] = line.split(":");
    return { index: +idx, name, active: active === "1" };
  });
}

/**
 * maw tab          — list tabs in current session
 * maw tab N        — peek tab N
 * maw tab N "msg"  — hey tab N
 * maw tab N --talk "msg" — talk-to tab N (future: #78)
 */
export async function cmdTab(tabArgs: string[]) {
  const session = await currentSession();
  const tabNum = tabArgs[0] ? parseInt(tabArgs[0], 10) : NaN;

  // maw tab — list all tabs
  if (isNaN(tabNum)) {
    const tabs = await listTabs(session);
    console.log(`\x1b[36m${session}\x1b[0m tabs:`);
    for (const t of tabs) {
      const marker = t.active ? " \x1b[32m← you are here\x1b[0m" : "";
      console.log(`  ${t.index}: ${t.name}${marker}`);
    }
    return;
  }

  // Resolve tab number → window name
  const tabs = await listTabs(session);
  const tab = tabs.find(t => t.index === tabNum);
  if (!tab) {
    console.error(`\x1b[31merror\x1b[0m: tab ${tabNum} not found in session \x1b[36m${session}\x1b[0m`);
    console.error(`available: ${tabs.map(t => t.index).join(", ")}`);
    process.exit(1);
  }

  const hasTalk = tabArgs.includes("--talk");
  const remaining = tabArgs.slice(1).filter(a => a !== "--force" && a !== "--talk");
  const force = tabArgs.includes("--force");

  // maw tab N — peek
  if (!remaining.length) {
    await cmdPeek(tab.name);
    return;
  }

  const message = remaining.join(" ");

  // maw tab N --talk "msg" — talk-to (MCP + hey)
  if (hasTalk) {
    await cmdTalkTo(tab.name, message, force);
    return;
  }

  // maw tab N "msg" — hey
  await cmdSend(tab.name, message, force);
}
