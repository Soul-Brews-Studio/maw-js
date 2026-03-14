import { listSessions, findWindow, capture, sendKeys, getPaneCommand, getPaneCommands } from "../ssh";

export async function cmdList() {
  const sessions = await listSessions();

  // Batch-check what process each pane is running
  const targets: string[] = [];
  for (const s of sessions) {
    for (const w of s.windows) targets.push(`${s.name}:${w.index}`);
  }
  const cmds = await getPaneCommands(targets);

  for (const s of sessions) {
    console.log(`\x1b[36m${s.name}\x1b[0m`);
    for (const w of s.windows) {
      const target = `${s.name}:${w.index}`;
      const proc = cmds[target] || "";
      const isAgent = /claude|codex|node/i.test(proc);

      let dot: string;
      let suffix = "";
      if (w.active && isAgent) {
        dot = "\x1b[32m●\x1b[0m"; // green — active + agent running
      } else if (isAgent) {
        dot = "\x1b[34m●\x1b[0m"; // blue — agent running
      } else {
        dot = "\x1b[31m●\x1b[0m"; // red — dead (shell only)
        suffix = `  \x1b[90m(${proc || "?"})\x1b[0m`;
      }
      console.log(`  ${dot} ${w.index}: ${w.name}${suffix}`);
    }
  }
}

export async function cmdPeek(query?: string) {
  const sessions = await listSessions();
  if (!query) {
    // Peek all — one line per agent
    for (const s of sessions) {
      for (const w of s.windows) {
        const target = `${s.name}:${w.index}`;
        try {
          const content = await capture(target, 3);
          const lastLine = content.split("\n").filter(l => l.trim()).pop() || "(empty)";
          const dot = w.active ? "\x1b[32m*\x1b[0m" : " ";
          console.log(`${dot} \x1b[36m${w.name.padEnd(22)}\x1b[0m ${lastLine.slice(0, 80)}`);
        } catch {
          console.log(`  \x1b[36m${w.name.padEnd(22)}\x1b[0m (unreachable)`);
        }
      }
    }
    return;
  }
  const target = findWindow(sessions, query);
  if (!target) { console.error(`window not found: ${query}`); process.exit(1); }
  const content = await capture(target);
  console.log(`\x1b[36m--- ${target} ---\x1b[0m`);
  console.log(content);
}

export async function cmdSend(query: string, message: string, force = false) {
  const sessions = await listSessions();
  const target = findWindow(sessions, query);
  if (!target) { console.error(`window not found: ${query}`); process.exit(1); }

  // Detect active Claude session (#17)
  if (!force) {
    const cmd = await getPaneCommand(target);
    const isAgent = /claude|codex|node/i.test(cmd);
    if (!isAgent) {
      console.error(`\x1b[31merror\x1b[0m: no active Claude session in ${target} (running: ${cmd})`);
      console.error(`\x1b[33mhint\x1b[0m:  run \x1b[36mmaw wake ${query}\x1b[0m first, or use \x1b[36m--force\x1b[0m to send anyway`);
      process.exit(1);
    }
  }

  await sendKeys(target, message);
  console.log(`\x1b[32msent\x1b[0m → ${target}: ${message}`);
}
