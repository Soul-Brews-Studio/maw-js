import { getTriggers, getTriggerHistory } from "../triggers";

export async function cmdTriggers(): Promise<void> {
  const triggers = getTriggers();
  const history = getTriggerHistory();

  if (!triggers.length) {
    console.log("\x1b[90mNo triggers configured. Add a 'triggers' array to maw.config.json.\x1b[0m");
    console.log(`\n\x1b[90mExample:\x1b[0m
  "triggers": [
    { "on": "issue-close", "repo": "Soul-Brews-Studio/maw-js", "action": "maw hey pulse-oracle 'issue closed'" },
    { "on": "pr-merge", "repo": "Soul-Brews-Studio/maw-js", "action": "maw done neo-mawjs" },
    { "on": "agent-idle", "timeout": 30, "action": "maw sleep {agent}" }
  ]`);
    return;
  }

  console.log(`\n\x1b[36mWorkflow Triggers\x1b[0m  (${triggers.length} configured)\n`);

  // Header
  console.log(
    "  " +
    pad("Event", 14) +
    pad("Repo/Filter", 30) +
    pad("Action", 40) +
    "Last Fired"
  );
  console.log("  " + "─".repeat(100));

  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    const last = history.find(h => h.index === i);

    const event = colorEvent(t.on) + (t.once ? " \x1b[33m[once]\x1b[0m" : "");
    const filter = t.repo || (t.timeout ? `timeout: ${t.timeout}s` : "—");
    const action = t.action.length > 38 ? t.action.slice(0, 35) + "..." : t.action;

    let lastStr = "\x1b[90m—\x1b[0m";
    if (last) {
      const ago = timeAgo(last.result.ts);
      const status = last.result.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      lastStr = `${status} ${ago}`;
    }

    console.log(
      "  " +
      pad(event, 14 + 9) + // +9 for ANSI escape codes
      pad(filter, 30) +
      pad(action, 40) +
      lastStr
    );
  }

  console.log();
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function colorEvent(event: string): string {
  switch (event) {
    case "issue-close": return "\x1b[35missue-close\x1b[0m";
    case "pr-merge":    return "\x1b[32mpr-merge\x1b[0m";
    case "agent-idle":  return "\x1b[33magent-idle\x1b[0m";
    case "agent-wake":  return "\x1b[36magent-wake\x1b[0m";
    case "agent-crash": return "\x1b[31magent-crash\x1b[0m";
    default:            return event;
  }
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
