import { tmux } from "../../sdk";
import { loadConfig } from "../../config";

/** @internal — exported for tests only. */
export interface AgentRow {
  node: string;
  session: string;
  window: string;
  oracle: string;
  state: "active" | "idle";
  pid: number | null;
}

const ORACLE_SUFFIX = "-oracle";
const SHELL_CMDS = new Set(["zsh", "bash", "sh", "fish", "dash"]);

/**
 * Build agent rows from raw pane data — pure, no I/O (testable).
 *
 * @param panes       - raw pane list from tmux.listPanes()
 * @param windowNames - Map<"session:winIdx", windowName> from tmux.listAll()
 * @param nodeName    - local node name (e.g. "oracle-world")
 * @param opts        - filter options
 *
 * @internal — exported for tests only.
 */
export function buildAgentRows(
  panes: Array<{ command: string; target: string; pid?: number }>,
  windowNames: Map<string, string>,
  nodeName: string,
  opts: { all?: boolean } = {},
): AgentRow[] {
  const rows: AgentRow[] = [];

  for (const pane of panes) {
    // target format from listPanes(): "session_name:window_index.pane_index"
    const m = pane.target.match(/^(.+):(\d+)\.\d+$/);
    if (!m) continue;
    const [, session, winIdxStr] = m;

    const windowName = windowNames.get(`${session}:${winIdxStr}`) ?? "";
    const isOracle = windowName.endsWith(ORACLE_SUFFIX);

    if (!opts.all && !isOracle) continue;

    const oracle = isOracle ? windowName.slice(0, -ORACLE_SUFFIX.length) : "";
    const state: "active" | "idle" = SHELL_CMDS.has(pane.command.toLowerCase()) ? "idle" : "active";

    rows.push({
      node: nodeName,
      session,
      window: windowName,
      oracle,
      state,
      pid: pane.pid ?? null,
    });
  }

  return rows;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function printTable(rows: AgentRow[]): void {
  const COL = { node: 14, session: 22, window: 22, oracle: 16, state: 8 };

  const header =
    pad("NODE", COL.node) +
    pad("SESSION", COL.session) +
    pad("WINDOW", COL.window) +
    pad("ORACLE", COL.oracle) +
    pad("STATE", COL.state) +
    "PID";

  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of rows) {
    const stateStr =
      r.state === "active"
        ? `\x1b[32m${r.state}\x1b[0m${" ".repeat(COL.state - r.state.length)}`
        : `\x1b[33m${r.state}\x1b[0m${" ".repeat(COL.state - r.state.length)}`;

    console.log(
      pad(r.node, COL.node) +
        pad(r.session, COL.session) +
        pad(r.window, COL.window) +
        pad(r.oracle, COL.oracle) +
        stateStr +
        (r.pid ?? "?"),
    );
  }
}

export async function cmdAgents(opts: {
  json?: boolean;
  all?: boolean;
  node?: string;
}): Promise<void> {
  if (opts.node) {
    console.log(`--node <name> federation not yet implemented`);
    console.log(`Track progress: https://github.com/Soul-Brews-Studio/maw-js/issues`);
    return;
  }

  const config = loadConfig();
  const nodeName = config.node || "local";

  const [sessions, panes] = await Promise.all([tmux.listAll(), tmux.listPanes()]);

  // Build window name lookup: "session:winIdx" → windowName
  const windowNames = new Map<string, string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      windowNames.set(`${s.name}:${w.index}`, w.name);
    }
  }

  const rows = buildAgentRows(panes, windowNames, nodeName, { all: opts.all });

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("no oracle agents found");
    return;
  }

  printTable(rows);
}
