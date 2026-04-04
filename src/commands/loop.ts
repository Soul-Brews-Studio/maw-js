/**
 * CLI commands for `maw loop` — manage scheduled prompt delivery.
 *
 * Usage:
 *   maw loop                              List all loops
 *   maw loop add '{...}'                  Add/update a loop (JSON)
 *   maw loop trigger <id>                 Trigger a loop now
 *   maw loop enable <id>                  Enable a loop
 *   maw loop disable <id>                 Disable a loop
 *   maw loop remove <id>                  Remove a loop
 *   maw loop history <id>                 Show loop state
 */

import {
  getLoops, getLoop, addLoop, removeLoop, enableLoop,
  triggerLoop, getLoopStates, nextCronTime,
  type LoopConfig,
} from "../loops";

function cronToHuman(cron: string): string {
  const [min, hour, dom, mon, dow] = cron.split(/\s+/);
  const parts: string[] = [];

  if (min.startsWith("*/")) parts.push(`every ${min.slice(2)} min`);
  else if (hour.startsWith("*/")) parts.push(`every ${hour.slice(2)} hr at :${min.padStart(2, "0")}`);
  else if (dow === "1-5") parts.push(`weekdays ${hour}:${min.padStart(2, "0")}`);
  else if (dow !== "*") parts.push(`dow ${dow} at ${hour}:${min.padStart(2, "0")}`);
  else if (dom !== "*") parts.push(`day ${dom} at ${hour}:${min.padStart(2, "0")}`);
  else if (hour !== "*" && min !== "*") parts.push(`daily ${hour}:${min.padStart(2, "0")}`);
  else parts.push(cron);

  return parts.join(", ");
}

function timeAgo(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function timeUntil(ms: number): string {
  const sec = Math.floor((ms - Date.now()) / 1000);
  if (sec < 0) return "now";
  if (sec < 60) return `in ${sec}s`;
  if (sec < 3600) return `in ${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `in ${Math.floor(sec / 3600)}h`;
  return `in ${Math.floor(sec / 86400)}d`;
}

export async function cmdLoop(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "ls" || sub === "list") {
    await cmdLoopList();
  } else if (sub === "add" || sub === "create") {
    await cmdLoopAdd(args.slice(1));
  } else if (sub === "trigger" || sub === "fire" || sub === "run") {
    await cmdLoopTrigger(args[1]);
  } else if (sub === "enable") {
    await cmdLoopEnable(args[1], true);
  } else if (sub === "disable") {
    await cmdLoopEnable(args[1], false);
  } else if (sub === "remove" || sub === "rm" || sub === "delete") {
    await cmdLoopRemove(args[1]);
  } else if (sub === "history" || sub === "status") {
    await cmdLoopHistory(args[1]);
  } else {
    console.log(`\x1b[36mmaw loop\x1b[0m — scheduled prompt delivery\n`);
    console.log(`  maw loop                    List all loops`);
    console.log(`  maw loop add '{...}'        Add/update loop (JSON)`);
    console.log(`  maw loop trigger <id>       Fire a loop now`);
    console.log(`  maw loop enable <id>        Enable a loop`);
    console.log(`  maw loop disable <id>       Disable a loop`);
    console.log(`  maw loop remove <id>        Remove a loop`);
    console.log(`  maw loop history <id>       Show loop run state\n`);
    console.log(`\x1b[33mJSON format:\x1b[0m`);
    console.log(`  {`);
    console.log(`    "id": "daily-monitor",`);
    console.log(`    "oracle": "luna-oracle",`);
    console.log(`    "schedule": "3 8 * * *",`);
    console.log(`    "prompt": "Run the daily monitor check",`);
    console.log(`    "description": "Daily repo monitor",`);
    console.log(`    "requireIdle": true,`);
    console.log(`    "enabled": true`);
    console.log(`  }`);
  }
}

async function cmdLoopList(): Promise<void> {
  const loops = getLoops();
  const states = getLoopStates();

  if (!loops.length) {
    console.log("\x1b[90mNo loops configured. Use `maw loop add '{...}'` to create one.\x1b[0m");
    console.log(`\n\x1b[90mExample:\x1b[0m`);
    console.log(`  maw loop add '{"id":"daily-check","oracle":"luna-oracle","schedule":"3 8 * * *","prompt":"bash scripts/oracle-monitor.sh --issues","enabled":true}'`);
    return;
  }

  console.log(`\n\x1b[36mScheduled Loops\x1b[0m  (${loops.length} configured)\n`);

  for (const loop of loops) {
    const state = states.get(loop.id);
    const icon = !loop.enabled ? "✗" : state?.lastOk === false ? "!" : state?.runCount ? "✓" : "○";
    const color = !loop.enabled ? "90" : state?.lastOk === false ? "31" : "32";

    console.log(`\x1b[${color}m${icon}\x1b[0m ${loop.id} \x1b[90m[${loop.oracle}]\x1b[0m`);

    if (loop.description) {
      console.log(`  ${loop.description}`);
    }

    const schedule = cronToHuman(loop.schedule);
    const lastStr = state?.lastRun ? timeAgo(state.lastRun) : "never";
    let nextStr = "—";
    try {
      if (loop.enabled) {
        const next = state?.nextRun || nextCronTime(loop.schedule).getTime();
        nextStr = timeUntil(next);
      }
    } catch { /* ignore */ }

    console.log(`  ${loop.schedule} (${schedule}) | last: ${lastStr} | next: ${nextStr}`);

    if (state && state.runCount > 0) {
      console.log(`  \x1b[90mruns: ${state.runCount} | errors: ${state.errors}\x1b[0m`);
    }
    console.log();
  }
}

async function cmdLoopAdd(args: string[]): Promise<void> {
  const jsonStr = args.join(" ");

  if (!jsonStr) {
    console.error("Usage: maw loop add '{\"id\":\"...\",\"oracle\":\"...\",\"schedule\":\"...\",\"prompt\":\"...\",\"enabled\":true}'");
    process.exit(1);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err: any) {
    console.error(`\x1b[31mInvalid JSON:\x1b[0m ${err.message}`);
    process.exit(1);
  }

  // Validate required fields
  if (!parsed.id || typeof parsed.id !== "string") {
    console.error("\x1b[31mMissing required field:\x1b[0m id (string)");
    process.exit(1);
  }
  if (!parsed.oracle || typeof parsed.oracle !== "string") {
    console.error("\x1b[31mMissing required field:\x1b[0m oracle (string)");
    process.exit(1);
  }
  if (!parsed.schedule || typeof parsed.schedule !== "string") {
    console.error("\x1b[31mMissing required field:\x1b[0m schedule (5-field cron)");
    process.exit(1);
  }
  if (!parsed.prompt || typeof parsed.prompt !== "string") {
    console.error("\x1b[31mMissing required field:\x1b[0m prompt (string)");
    process.exit(1);
  }

  // Validate cron expression
  try {
    nextCronTime(parsed.schedule);
  } catch (err: any) {
    console.error(`\x1b[31mInvalid cron expression:\x1b[0m ${err.message}`);
    process.exit(1);
  }

  const loop: LoopConfig = {
    id: parsed.id,
    oracle: parsed.oracle,
    tmux: parsed.tmux,
    schedule: parsed.schedule,
    prompt: parsed.prompt,
    description: parsed.description,
    requireIdle: parsed.requireIdle ?? true,
    enabled: parsed.enabled ?? true,
  };

  const existing = getLoop(loop.id);
  addLoop(loop);

  const action = existing ? "updated" : "added";
  const schedule = cronToHuman(loop.schedule);
  const next = nextCronTime(loop.schedule);
  const nextStr = next.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

  console.log(`\x1b[32m✓\x1b[0m loop ${action}: ${loop.id}`);
  console.log(`  oracle: ${loop.oracle}`);
  console.log(`  schedule: ${loop.schedule} (${schedule})`);
  console.log(`  next: ${next.toLocaleDateString()} ${nextStr}`);
  console.log(`  prompt: ${loop.prompt.slice(0, 80)}${loop.prompt.length > 80 ? "..." : ""}`);

  if (!process.env.MAW_CLI) {
    // If running inside the server, schedule it live
    const { startAllLoops } = await import("../loops");
    startAllLoops();
  } else {
    console.log(`\n\x1b[90mRestart maw server to activate, or: maw loop trigger ${loop.id}\x1b[0m`);
  }
}

async function cmdLoopTrigger(id?: string): Promise<void> {
  if (!id) {
    console.error("Usage: maw loop trigger <id>");
    process.exit(1);
  }

  const loop = getLoop(id);
  if (!loop) {
    console.error(`\x1b[31mLoop not found:\x1b[0m ${id}`);
    process.exit(1);
  }

  console.log(`\x1b[36m[loop]\x1b[0m Triggering ${id} → ${loop.oracle}...`);
  await triggerLoop(id);
}

async function cmdLoopEnable(id: string | undefined, enabled: boolean): Promise<void> {
  if (!id) {
    console.error(`Usage: maw loop ${enabled ? "enable" : "disable"} <id>`);
    process.exit(1);
  }

  if (enableLoop(id, enabled)) {
    console.log(`\x1b[32m✓\x1b[0m ${id} ${enabled ? "enabled" : "disabled"}`);
  } else {
    console.error(`\x1b[31mLoop not found:\x1b[0m ${id}`);
    process.exit(1);
  }
}

async function cmdLoopRemove(id?: string): Promise<void> {
  if (!id) {
    console.error("Usage: maw loop remove <id>");
    process.exit(1);
  }

  if (removeLoop(id)) {
    console.log(`\x1b[32m✓\x1b[0m loop removed: ${id}`);
  } else {
    console.error(`\x1b[31mLoop not found:\x1b[0m ${id}`);
    process.exit(1);
  }
}

async function cmdLoopHistory(id?: string): Promise<void> {
  if (!id) {
    // Show all states
    const loops = getLoops();
    const states = getLoopStates();
    if (!loops.length) { console.log("\x1b[90mNo loops.\x1b[0m"); return; }

    console.log(`\n\x1b[36mLoop Status\x1b[0m\n`);
    for (const loop of loops) {
      const state = states.get(loop.id);
      console.log(`  ${loop.id}: runs=${state?.runCount || 0} errors=${state?.errors || 0} last=${state?.lastRun ? timeAgo(state.lastRun) : "never"}`);
    }
    return;
  }

  const loop = getLoop(id);
  if (!loop) {
    console.error(`\x1b[31mLoop not found:\x1b[0m ${id}`);
    process.exit(1);
  }

  const state = getLoopStates().get(id);

  console.log(`\n\x1b[36mLoop: ${id}\x1b[0m\n`);
  console.log(`  Oracle:     ${loop.oracle}`);
  console.log(`  Schedule:   ${loop.schedule} (${cronToHuman(loop.schedule)})`);
  console.log(`  Enabled:    ${loop.enabled}`);
  console.log(`  Prompt:     ${loop.prompt}`);
  if (loop.description) console.log(`  Description: ${loop.description}`);
  console.log();
  console.log(`  Runs:       ${state?.runCount || 0}`);
  console.log(`  Errors:     ${state?.errors || 0}`);
  console.log(`  Last run:   ${state?.lastRun ? new Date(state.lastRun).toLocaleString() + ` (${timeAgo(state.lastRun)})` : "never"}`);
  console.log(`  Last ok:    ${state?.lastOk ?? "—"}`);

  try {
    const next = state?.nextRun || nextCronTime(loop.schedule).getTime();
    console.log(`  Next run:   ${new Date(next).toLocaleString()} (${timeUntil(next)})`);
  } catch { /* ignore */ }
}
