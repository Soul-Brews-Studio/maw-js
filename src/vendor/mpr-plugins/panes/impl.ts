import { listSessions, hostExec, tmuxCmd } from "maw-js/sdk";
import { resolveSessionTarget } from "maw-js/core/matcher/resolve-target";

export interface PanesOpts {
  /** Include a PID column (for /proc inspection / ghost detection). */
  pid?: boolean;
  /** Enumerate every pane across every session (tmux list-panes -a). */
  all?: boolean;
}

interface PaneRow {
  target: string;   // session:window.pane
  dims: string;     // WIDTHxHEIGHT
  command: string;
  title: string;
  pid?: string;     // only populated when opts.pid
}

/**
 * maw panes [target]
 *
 * List panes with metadata. Default target is the current tmux window.
 * If target is a bare session name, lists panes across ALL its windows.
 * If target is session:window, lists panes of that window.
 *
 * Output columns — target, dims, command, title — match the style of
 * `maw ls`: plain text, ANSI-colored header, one row per pane.
 */
export async function cmdPanes(target?: string, opts: PanesOpts = {}) {
  const tmux = tmuxCmd();

  let filter: string | null = null; // tmux -t target for list-panes; null = current
  if (opts.all) {
    if (target) console.log(`  \x1b[90m⚠ --all ignores target argument\x1b[0m`);
    // skip target resolution entirely — --all enumerates everything
  } else if (target) {
    if (target.includes(":")) {
      // Resolve session portion only; window stays as-is
      const [rawSession, rest] = target.split(":", 2);
      const sessions = await listSessions();
      const r = resolveSessionTarget(rawSession, sessions);
      if (r.kind === "ambiguous") {
        console.error(`  \x1b[31m✗\x1b[0m '${rawSession}' is ambiguous — matches ${r.candidates.length} sessions:`);
        for (const s of r.candidates) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
        throw new Error(`'${rawSession}' is ambiguous — matches ${r.candidates.length} sessions`);
      }
      if (r.kind === "none") {
        if (r.hints && r.hints.length > 0) {
          console.error(`  \x1b[90m  did you mean:\x1b[0m`);
          for (const s of r.hints) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
        }
        throw new Error(`session '${rawSession}' not found`);
      }
      filter = `${r.match.name}:${rest}`;
    } else {
      const sessions = await listSessions();
      const r = resolveSessionTarget(target, sessions);
      if (r.kind === "ambiguous") {
        console.error(`  \x1b[31m✗\x1b[0m '${target}' is ambiguous — matches ${r.candidates.length} sessions:`);
        for (const s of r.candidates) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
        throw new Error(`'${target}' is ambiguous — matches ${r.candidates.length} sessions`);
      }
      if (r.kind === "none") {
        if (r.hints && r.hints.length > 0) {
          console.error(`  \x1b[90m  did you mean:\x1b[0m`);
          for (const s of r.hints) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
        } else {
          console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
        }
        throw new Error(`session '${target}' not found`);
      }
      // Session-wide: use list-panes -s
      filter = r.match.name;
    }
  }

  // Build list-panes command. Format uses ||| as field separator.
  // #{pane_pid} only appended when --pid requested, to keep default output stable.
  const baseFmt = "#{session_name}:#{window_index}.#{pane_index}|||#{pane_width}x#{pane_height}|||#{pane_current_command}|||#{pane_title}";
  const fmt = opts.pid ? `${baseFmt}|||#{pane_pid}` : baseFmt;
  const targetFlag = opts.all ? "-a" : (filter ? `-s -t '${filter}'` : "");
  let raw: string;
  try {
    raw = await hostExec(`${tmux} list-panes ${targetFlag} -F '${fmt}'`);
  } catch (e: any) {
    throw new Error(`list-panes failed: ${e.message || e}`);
  }

  const rows: PaneRow[] = raw.split("\n").filter(Boolean).map(line => {
    const parts = line.split("|||");
    return {
      target: parts[0]!,
      dims: parts[1]!,
      command: parts[2]!,
      title: parts[3] || "",
      pid: opts.pid ? parts[4] : undefined,
    };
  });

  if (rows.length === 0) {
    console.log("  \x1b[90m(no panes)\x1b[0m");
    return;
  }

  // Column widths
  const w = {
    target: Math.max(6, ...rows.map(r => r.target.length)),
    dims:   Math.max(6, ...rows.map(r => r.dims.length)),
    cmd:    Math.max(7, ...rows.map(r => r.command.length)),
    pid:    opts.pid ? Math.max(3, ...rows.map(r => (r.pid || "").length)) : 0,
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

  if (opts.pid) {
    console.log(`  \x1b[90m${pad("TARGET", w.target)}  ${pad("SIZE", w.dims)}  ${pad("PID", w.pid)}  ${pad("COMMAND", w.cmd)}  TITLE\x1b[0m`);
    for (const row of rows) {
      console.log(`  ${pad(row.target, w.target)}  ${pad(row.dims, w.dims)}  ${pad(row.pid || "", w.pid)}  ${pad(row.command, w.cmd)}  \x1b[90m${row.title}\x1b[0m`);
    }
  } else {
    console.log(`  \x1b[90m${pad("TARGET", w.target)}  ${pad("SIZE", w.dims)}  ${pad("COMMAND", w.cmd)}  TITLE\x1b[0m`);
    for (const row of rows) {
      console.log(`  ${pad(row.target, w.target)}  ${pad(row.dims, w.dims)}  ${pad(row.command, w.cmd)}  \x1b[90m${row.title}\x1b[0m`);
    }
  }
}
