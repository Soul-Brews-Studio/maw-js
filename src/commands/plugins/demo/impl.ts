import { hostExec } from "../../../core/transport/ssh";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DemoOpts {
  /** Skip sleep delays — useful for CI / screenshot automation. */
  fast?: boolean;
  /** Injectable sleep fn — tests pass a no-op to run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable hostExec fn — tests can intercept tmux calls. */
  exec?: (cmd: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Canned dialogue
// ---------------------------------------------------------------------------

// NOTE: bash parameter expansions like ${1:-} would be parsed as JS template
// expressions if we used backtick strings. Use function builders instead so
// we can splice in the fast flag as a literal value at demo start time.

function buildAgent1Script(fast: boolean): string {
  const fastVal = fast ? "1" : "";
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `FAST=${JSON.stringify(fastVal)}`,
    "pause() { [ -n \"$FAST\" ] && return 0; sleep \"$1\"; }",
    "echo \"\"",
    "echo \"  \\033[36m[agent-1]\\033[0m ● session started\"",
    "pause 2",
    "echo \"  \\033[36m[agent-1]\\033[0m → reading task: 'summarize this repo and suggest improvements'\"",
    "pause 3",
    "echo \"  \\033[36m[agent-1]\\033[0m   scanning source tree...\"",
    "pause 2",
    "echo \"  \\033[36m[agent-1]\\033[0m   found 57 command plugins across src/commands/plugins/\"",
    "pause 2",
    "echo \"  \\033[36m[agent-1]\\033[0m   found 94 test files (test/ + test/isolated/)\"",
    "pause 2",
    "echo \"  \\033[36m[agent-1]\\033[0m   found 19 API endpoints in src/api/\"",
    "pause 3",
    "echo \"\"",
    "echo \"  \\033[36m[agent-1]\\033[0m ✓ summary ready — handing off to agent-2 for improvements pass\"",
    "echo \"\"",
  ].join("\n");
}

function buildAgent2Script(fast: boolean): string {
  const fastVal = fast ? "1" : "";
  const initialDelay = fast ? "0" : "4";
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `FAST=${JSON.stringify(fastVal)}`,
    `sleep ${initialDelay}`,
    "pause() { [ -n \"$FAST\" ] && return 0; sleep \"$1\"; }",
    "echo \"\"",
    "echo \"  \\033[33m[agent-2]\\033[0m ● session started\"",
    "pause 2",
    "echo \"  \\033[33m[agent-2]\\033[0m → received handoff from agent-1\"",
    "pause 3",
    "echo \"  \\033[33m[agent-2]\\033[0m   analysing improvement opportunities...\"",
    "pause 2",
    "echo \"  \\033[33m[agent-2]\\033[0m   [1] ship maw init wizard — reduce setup from 6 steps to 30 seconds\"",
    "pause 2",
    "echo \"  \\033[33m[agent-2]\\033[0m   [2] add asciinema to README — first-5-minute retention lever\"",
    "pause 2",
    "echo \"  \\033[33m[agent-2]\\033[0m   [3] maw costs --daily sparkline — 80% already built\"",
    "pause 3",
    "echo \"\"",
    "echo \"  \\033[33m[agent-2]\\033[0m ✓ improvements filed — 3 issues created\"",
    "echo \"\"",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function say(msg: string): void {
  process.stdout.write(msg + "\n");
}

function header(msg: string): void {
  say(`\n${CYAN}${msg}${RESET}`);
}

function step(msg: string): void {
  say(`  ${DIM}\u2192${RESET} ${msg}`);
}

function ok(msg: string): void {
  say(`  ${GREEN}\u2713${RESET} ${msg}`);
}

// ---------------------------------------------------------------------------
// Tmux helpers — thin wrappers that delegate to exec so tests can intercept
// ---------------------------------------------------------------------------

async function listPaneIds(
  exec: (cmd: string) => Promise<string>,
): Promise<Set<string>> {
  const raw = await exec("tmux list-panes -a -F #{pane_id}").catch(() => "");
  return new Set(raw.split("\n").filter(Boolean));
}

/** Current pane target — uses $TMUX_PANE when available, else fallback ".". */
function callerTarget(): string {
  return process.env.TMUX_PANE ?? ":.";
}

/** Write a bash script to a temp file, make it executable, return path. */
async function writeTempScript(
  content: string,
  exec: (cmd: string) => Promise<string>,
): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = `/tmp/maw-demo-${suffix}.sh`;
  await Bun.write(path, content + "\n");
  await exec(`chmod +x '${path}'`);
  return path;
}

// ---------------------------------------------------------------------------
// Main demo runner
// ---------------------------------------------------------------------------

export async function cmdDemo(opts: DemoOpts = {}): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const exec = opts.exec ?? ((cmd: string) => hostExec(cmd));
  const fast = opts.fast ?? false;
  const delay = fast ? 0 : 1;

  // --- Guard: must be inside tmux ------------------------------------------

  if (!process.env.TMUX) {
    say("");
    say(`  ${CYAN}maw demo${RESET} \u2014 simulated multi-agent session`);
    say("");
    say(`  ${DIM}This demo requires an active tmux session.${RESET}`);
    say(`  Run: ${CYAN}tmux new-session -s demo${RESET}`);
    say(`  Then re-run: ${CYAN}maw demo${RESET}`);
    say("");
    return;
  }

  // --- Narrator intro -------------------------------------------------------

  header("\uD83C\uDFAC  maw demo \u2014 simulated multi-agent session");
  say(`  ${DIM}No API key required. Zero real Claude calls.${RESET}`);
  say(`  ${DIM}Two mock agents will work on a canned task.${RESET}`);
  await sleep(delay * 1200);

  // --- Build agent scripts --------------------------------------------------

  const script1 = buildAgent1Script(fast);
  const script2 = buildAgent2Script(fast);

  let path1 = "";
  let path2 = "";
  let pane1Id: string | undefined;
  let pane2Id: string | undefined;
  const callerPane = callerTarget();

  try {
    step("writing agent scripts...");
    path1 = await writeTempScript(script1, exec);
    path2 = await writeTempScript(script2, exec);
    await sleep(delay * 300);

    // --- Split pane 1 (right/left sibling) -----------------------------------

    step("spawning agent-1 in left pane...");
    const before1 = await listPaneIds(exec);

    await exec(
      `tmux split-window -t '${callerPane}' -h -l 50% ` +
        `'bash ${path1}; echo "  [agent-1] session ended"; ` +
        `read -p "" 2>/dev/null || true'`,
    );

    await sleep(delay * 800);

    const after1 = await listPaneIds(exec);
    pane1Id = [...after1].find((id) => !before1.has(id));
    ok(`agent-1 spawned${pane1Id ? ` (${pane1Id})` : ""}`);
    await sleep(delay * 600);

    // --- Split pane 2 (below agent-1) ----------------------------------------

    step("spawning agent-2 in right pane...");
    const before2 = await listPaneIds(exec);
    const splitTarget = pane1Id ?? callerPane;

    await exec(
      `tmux split-window -t '${splitTarget}' -v -l 50% ` +
        `'bash ${path2}; echo "  [agent-2] session ended"; ` +
        `read -p "" 2>/dev/null || true'`,
    );

    await sleep(delay * 800);

    const after2 = await listPaneIds(exec);
    pane2Id = [...after2].find((id) => !before2.has(id));
    ok(`agent-2 spawned${pane2Id ? ` (${pane2Id})` : ""}`);
    await sleep(delay * 600);

    // --- Narrator task broadcast ---------------------------------------------

    header("\uD83D\uDCE1  broadcasting task to both agents");
    step(`task: "summarize this repo and suggest improvements"`);
    await sleep(delay * 1500);

    // --- Wait for agents to "finish" (scripted duration) ---------------------

    header("\u23F3  agents working...");
    say(`  ${DIM}Watch the side panes for their output.${RESET}`);
    // Agent 1 ~14s, agent 2 ~18s; fast mode = 500ms (just enough to be visible)
    await sleep(fast ? 500 : 18_000);

    // --- Cost summary --------------------------------------------------------

    header("\uD83D\uDCB0  gathering cost data...");
    await sleep(delay * 1000);

    const sep = "\u2500".repeat(52);
    say("");
    say(`  ${sep}`);
    say(`  ${CYAN}COST REPORT \u2014 demo session${RESET}`);
    say(`  ${sep}`);
    say(`  ${"agent-1".padEnd(20)}  ${"0 tokens".padStart(12)}  ${GREEN}$0.00${RESET}`);
    say(`  ${"agent-2".padEnd(20)}  ${"0 tokens".padStart(12)}  ${GREEN}$0.00${RESET}`);
    say(`  ${sep}`);
    say(
      `  ${"TOTAL".padEnd(20)}  ${"0 tokens".padStart(12)}  ${GREEN}$0.00${RESET}  ` +
        `${DIM}(demo mode \u2014 no real Claude calls)${RESET}`,
    );
    say(`  ${sep}`);
    say("");
    await sleep(delay * 1500);

    // --- Closing message -----------------------------------------------------

    say(`  ${GREEN}\u2713 demo complete.${RESET}`);
    say("");
    say(`  ${DIM}For the real thing:${RESET}`);
    say(`    ${CYAN}maw wake <your-repo>${RESET}   \u2014 spawn a real agent from any GitHub repo`);
    say(`    ${CYAN}maw hey <agent> "..."${RESET}   \u2014 send it a task`);
    say(`    ${CYAN}maw peek <agent>${RESET}         \u2014 watch its screen`);
    say(`    ${CYAN}maw costs${RESET}                \u2014 see what it spent`);
    say("");
    say(
      `  ${DIM}Install: curl -fsSL https://github.com/Soul-Brews-Studio/maw-js/install.sh | bash${RESET}`,
    );
    say("");
  } finally {
    // --- Cleanup: kill demo panes after a brief pause -----------------------
    await sleep(fast ? 200 : 4_000);

    if (pane2Id) {
      await exec(`tmux kill-pane -t '${pane2Id}'`).catch(() => "");
    }
    if (pane1Id) {
      await exec(`tmux kill-pane -t '${pane1Id}'`).catch(() => "");
    }

    // Clean up temp scripts
    if (path1) await exec(`rm -f '${path1}'`).catch(() => "");
    if (path2) await exec(`rm -f '${path2}'`).catch(() => "");
  }
}
