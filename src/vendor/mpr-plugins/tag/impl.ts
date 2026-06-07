import { listSessions, hostExec, tmuxCmd } from "maw-js/sdk";
import { resolveSessionTarget } from "maw-js/core/matcher/resolve-target";

export interface TagOpts {
  /** Pane index within the target window (default: active pane of the window). */
  pane?: number;
  /** Pane title — surfaces in status bar + tmux list-panes output. */
  title?: string;
  /** User-defined options as key=val pairs. Sets tmux @custom options on the pane. */
  meta?: string[];
}

/**
 * maw tag <target> [--pane N] [--title <text>] [--meta key=val ...]
 *
 * Set pane metadata so callers can identify panes deterministically
 * instead of guessing via active-pane heuristics. Wraps two tmux knobs:
 *
 *   - tmux select-pane -T '<title>'   — sets pane_title
 *   - tmux set-option -p @<key> '<val>' — sets user option on the pane
 *
 * Why: enables route-by-name for skills that need to distinguish the
 * oracle's main pane from team-agent panes, without depending on pane
 * index ordering or process name. Example:
 *
 *   maw tag mawjs --title 'oracle' --meta agent-name=mawjs --meta role=oracle
 *   maw tag mawjs --pane 1 --title 'scout' --meta agent-name=scout --meta role=teammate
 *
 * Then `maw panes` shows the title column; skills can grep it or read
 * the @custom options via `tmux show-options -p -t <target>`.
 */
export async function cmdTag(target: string, opts: TagOpts = {}) {
  if (!target) {
    console.error("usage: maw tag <target> [--pane N] [--title <text>] [--meta key=val]");
    console.error("       maw tag <target>                   (read mode — show current tags)");
    throw new Error("usage: maw tag <target> [--pane N] [--title <text>] [--meta key=val]");
  }

  // Read mode: no write flags → show current tags on the target pane.
  const isRead = !opts.title && (!opts.meta || opts.meta.length === 0);

  const tmux = tmuxCmd();

  // Resolve target (session:window or bare session) via canonical matcher.
  let resolvedTarget: string;
  if (target.includes(":")) {
    const [rawSession, winPart] = target.split(":", 2);
    const sessions = await listSessions();
    const r = resolveSessionTarget(rawSession, sessions);
    if (r.kind === "ambiguous") {
      console.error(`  \x1b[31m✗\x1b[0m '${rawSession}' is ambiguous — matches ${r.candidates.length} sessions:`);
      for (const s of r.candidates) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      throw new Error(`'${rawSession}' is ambiguous`);
    }
    if (r.kind === "none") {
      console.error(`  \x1b[31m✗\x1b[0m session '${rawSession}' not found`);
      if (r.hints?.length) {
        console.error(`  \x1b[90m  did you mean:\x1b[0m`);
        for (const s of r.hints) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      }
      throw new Error(`session '${rawSession}' not found`);
    }
    resolvedTarget = `${r.match.name}:${winPart ?? "0"}`;
  } else {
    const sessions = await listSessions();
    const r = resolveSessionTarget(target, sessions);
    if (r.kind === "ambiguous") {
      console.error(`  \x1b[31m✗\x1b[0m '${target}' is ambiguous — matches ${r.candidates.length} sessions:`);
      for (const s of r.candidates) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      throw new Error(`'${target}' is ambiguous`);
    }
    if (r.kind === "none") {
      console.error(`  \x1b[31m✗\x1b[0m session '${target}' not found`);
      if (r.hints?.length) {
        console.error(`  \x1b[90m  did you mean:\x1b[0m`);
        for (const s of r.hints) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      } else {
        console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
      }
      throw new Error(`session '${target}' not found`);
    }
    resolvedTarget = `${r.match.name}:${r.match.windows[0]?.index ?? 0}`;
  }

  // Append .pane if supplied; otherwise tmux targets the window's active pane.
  const fullTarget = opts.pane !== undefined ? `${resolvedTarget}.${opts.pane}` : resolvedTarget;

  // Read mode: print title + all @custom options for the pane.
  if (isRead) {
    try {
      const title = (await hostExec(
        `${tmux} display-message -p -t '${fullTarget}' '#{pane_title}'`,
      )).trim();
      const optsRaw = await hostExec(`${tmux} show-options -p -t '${fullTarget}'`).catch(() => "");
      const customLines = optsRaw
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.startsWith("@"));

      console.log(`  \x1b[36m${fullTarget}\x1b[0m`);
      console.log(`  \x1b[90m  title:\x1b[0m ${title || "(none)"}`);
      if (customLines.length === 0) {
        console.log(`  \x1b[90m  meta:  (none)\x1b[0m`);
      } else {
        console.log(`  \x1b[90m  meta:\x1b[0m`);
        for (const line of customLines) {
          console.log(`  \x1b[90m    ${line}\x1b[0m`);
        }
      }
      return;
    } catch (e: any) {
      throw new Error(`read failed: ${e.message || e}`);
    }
  }

  // Set title — tmux handles the empty-string case by clearing the title.
  if (opts.title !== undefined) {
    const escapedTitle = opts.title.replace(/'/g, "'\\''");
    try {
      await hostExec(`${tmux} select-pane -t '${fullTarget}' -T '${escapedTitle}'`);
      console.log(`  \x1b[32m✓\x1b[0m title: ${fullTarget} = '${opts.title}'`);
    } catch (e: any) {
      throw new Error(`select-pane -T failed: ${e.message || e}`);
    }
  }

  // Apply each --meta key=val as a pane-scoped user option (@custom).
  for (const kv of opts.meta ?? []) {
    const eqIdx = kv.indexOf("=");
    if (eqIdx <= 0) {
      throw new Error(`--meta must be key=val (got: ${kv})`);
    }
    const key = kv.slice(0, eqIdx).trim();
    const val = kv.slice(eqIdx + 1);
    const optKey = key.startsWith("@") ? key : `@${key}`;
    const escapedVal = val.replace(/'/g, "'\\''");
    try {
      await hostExec(`${tmux} set-option -p -t '${fullTarget}' '${optKey}' '${escapedVal}'`);
      console.log(`  \x1b[32m✓\x1b[0m meta: ${fullTarget} ${optKey} = '${val}'`);
    } catch (e: any) {
      throw new Error(`set-option failed: ${e.message || e}`);
    }
  }
}
