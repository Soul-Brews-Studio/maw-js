import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { activeDurationArg, cmdTmuxPeek, cmdTmuxLs, cmdTmuxSend, cmdTmuxSplit, cmdTmuxKill, cmdTmuxLayout, cmdTmuxPipePane, cmdTmuxSynchronizePanes, cmdTmuxAttach, parseActiveDurationSeconds, resolveTmuxTarget } from "./impl";
import { hostExec } from "../../../sdk";

export const command = {
  name: "tmux",
  description: "tmux control verbs — peek.",
};

interface TmuxHandlerDeps {
  cmdTmuxPeek: typeof cmdTmuxPeek;
  cmdTmuxLs: typeof cmdTmuxLs;
  cmdTmuxSend: typeof cmdTmuxSend;
  cmdTmuxSplit: typeof cmdTmuxSplit;
  cmdTmuxKill: typeof cmdTmuxKill;
  cmdTmuxLayout: typeof cmdTmuxLayout;
  cmdTmuxPipePane: typeof cmdTmuxPipePane;
  cmdTmuxSynchronizePanes: typeof cmdTmuxSynchronizePanes;
  cmdTmuxAttach: typeof cmdTmuxAttach;
  resolveTmuxTarget: typeof resolveTmuxTarget;
  hostExec: typeof hostExec;
  cmdSplit: (target: string, opts: { lock?: boolean }) => Promise<void>;
}

const defaultDeps: TmuxHandlerDeps = {
  cmdTmuxPeek,
  cmdTmuxLs,
  cmdTmuxSend,
  cmdTmuxSplit,
  cmdTmuxKill,
  cmdTmuxLayout,
  cmdTmuxPipePane,
  cmdTmuxSynchronizePanes,
  cmdTmuxAttach,
  resolveTmuxTarget,
  hostExec,
  cmdSplit: cmdTmuxSplit as TmuxHandlerDeps["cmdSplit"],
};

export function createTmuxHandler(overrides: Partial<TmuxHandlerDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  return async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (sub === "send") {
      const flags = parseFlags(args, {
        "--literal": Boolean,
        "--allow-destructive": Boolean,
        "--force": Boolean,
        "--help": Boolean,
        "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux send <target> <command> [--literal] [--allow-destructive] [--force]");
        console.log("  target:  pane id (%N), session:w.p, team-agent, fleet stem, or session name");
        console.log("  --literal:           don't append Enter (raw keystrokes)");
        console.log("  --allow-destructive: bypass deny-list (rm/sudo/redirect/...)");
        console.log("  --force:             bypass refusal-to-inject-into-claude-pane");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      const command = flags._.slice(1).join(" ");
      if (!target || !command) {
        console.log("usage: maw tmux send <target> <command> [--literal] [--allow-destructive] [--force]");
        return { ok: false, error: "target and command required", output: logs.join("\n") };
      }
      await deps.cmdTmuxSend(target, command, {
        literal: !!flags["--literal"],
        allowDestructive: !!flags["--allow-destructive"],
        force: !!flags["--force"],
      });
    } else if (sub === "ls" || sub === "list") {
      const flags = parseFlags(args, {
        "--all": Boolean,
        "-a": "--all",
        "--json": Boolean,
        "--compact": Boolean,
        "-c": "--compact",
        "--verbose": Boolean,
        "-v": "--verbose",
        "--roster": Boolean,
        "--recent": Boolean,
        "-r": "--recent",
        "--active": Boolean,
        "--node": String,
        "--channels": Boolean,
        "--help": Boolean,
        "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux ls [filter|--node NODE] [--all|-a] [--channels] [--compact|-c] [-v|--verbose] [--recent|-r [N]] [--active [30m|1h]] [--roster] [--json]");
        console.log("  default:    panes in current session only");
        console.log("  --all:      panes across every session");
        console.log("  --compact:  one line per session (`maw ls` / `maw ls -c` top-level)");
        console.log("  -v:         full per-pane detail");
        console.log("  --roster:   include sleeping oracles from ghq");
        console.log("  --recent:   sort sessions newest-first by tmux creation time; optional N limits sessions");
        console.log("  --active:   filter to sessions active within threshold (default 30m)");
        console.log("  --node:     filter sessions by node/session text");
        console.log("  --channels: include infrastructure channel sessions such as *-discord");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const positionals = flags._ as string[];
      const activeArg = activeDurationArg(args.slice(1));
      const filterPositionals = activeArg
        ? positionals.filter((arg) => arg !== activeArg)
        : positionals;
      const recentLimitRaw = positionals.find((arg) => /^\d+$/.test(arg));
      const recentLimit = recentLimitRaw ? Number(recentLimitRaw) : undefined;
      const nodeFilter = typeof flags["--node"] === "string" ? flags["--node"].trim() : "";
      const positionalFilter = filterPositionals.find((arg) => !/^\d+$/.test(arg) && !(flags["--active"] && parseActiveDurationSeconds(arg)))?.trim() ?? "";
      const lsOpts = {
        all: !!flags["--all"] || !!flags["--recent"] || !!flags["--active"],
        json: !!flags["--json"],
        compact: !!flags["--compact"] || !!flags["--recent"] || !!flags["--active"],
        verbose: !!flags["--verbose"],
        roster: !!flags["--roster"],
        recent: !!flags["--recent"],
        recentLimit: Number.isSafeInteger(recentLimit) && recentLimit! > 0 ? recentLimit : undefined,
      } as Parameters<typeof deps.cmdTmuxLs>[0];
      if (flags["--active"]) {
        lsOpts.active = true;
        lsOpts.activeThresholdSec = parseActiveDurationSeconds(activeArg);
      }
      const filter = nodeFilter || positionalFilter;
      if (filter) lsOpts.filter = filter;
      if (flags["--channels"] || flags["--all"]) lsOpts.channels = true;
      await deps.cmdTmuxLs(lsOpts);
    } else if (sub === "peek") {
      const flags = parseFlags(args, {
        "--lines": Number,
        "--history": Boolean,
        "--help": Boolean,
        "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux peek <target> [--lines N] [--history]");
        console.log("  target: pane id (%N), session:w.p, team-agent name, or session name");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux peek <target> [--lines N] [--history]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      const lines = (flags["--lines"] as number | undefined) ?? 30;
      const history = !!flags["--history"];
      await deps.cmdTmuxPeek(target, { lines, history });
    } else if (sub === "split") {
      const flags = parseFlags(args, {
        "--vertical": Boolean, "-v": "--vertical",
        "--horizontal": Boolean, "-h": "--horizontal",
        "--pct": Number,
        "--cmd": String,
        "--help": Boolean,
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux split <target> [-v|--vertical] [--pct N] [--cmd '<cmd>']");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux split <target> [-v] [--pct N] [--cmd '<cmd>']");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      await deps.cmdTmuxSplit(target, {
        vertical: !!flags["--vertical"],
        pct: flags["--pct"] as number | undefined,
        cmd: flags["--cmd"] as string | undefined,
      });
    } else if (sub === "kill") {
      const flags = parseFlags(args, {
        "--force": Boolean,
        "--session": Boolean, "-s": "--session",
        "--help": Boolean, "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux kill <target> [--force] [--session|-s]");
        console.log("  default: kill the pane. --session/-s: kill the whole session.");
        console.log("  refuses fleet/view sessions unless --force.");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux kill <target> [--force] [--session]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      await deps.cmdTmuxKill(target, {
        force: !!flags["--force"],
        session: !!flags["--session"],
      });
    } else if (sub === "layout") {
      const flags = parseFlags(args, { "--help": Boolean, "-h": "--help" }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux layout <target> <preset>");
        console.log("  presets: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      const preset = flags._[1];
      if (!target || !preset) {
        console.log("usage: maw tmux layout <target> <preset>");
        return { ok: false, error: "target and preset required", output: logs.join("\n") };
      }
      await deps.cmdTmuxLayout(target, preset);
    } else if (sub === "pipe" || sub === "pipe-pane") {
      const flags = parseFlags(args, {
        "--input": Boolean, "-I": "--input",
        "--output": Boolean, "-O": "--output",
        "--no-output": Boolean,
        "--only-if-closed": Boolean,
        "--open": "--only-if-closed",
        "-o": "--only-if-closed",
        "--help": Boolean, "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux pipe <target> [command] [--input] [--output|--no-output] [--only-if-closed|-o]");
        console.log("  default: pipe pane output to command stdin (`tmux pipe-pane -O`).");
        console.log("  omit command to close the current pipe for the target pane.");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux pipe <target> [command] [--input] [--output|--no-output] [--only-if-closed]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      if (flags["--no-output"] && !flags["--input"]) {
        return { ok: false, error: "--no-output requires --input", output: logs.join("\n") || undefined };
      }
      const command = flags._.slice(1).join(" ") || undefined;
      await deps.cmdTmuxPipePane(target, command, {
        input: !!flags["--input"],
        output: flags["--no-output"] ? false : flags["--output"] ? true : undefined,
        onlyIfClosed: !!flags["--only-if-closed"],
      });
    } else if (sub === "sync" || sub === "synchronize-panes") {
      const flags = parseFlags(args, { "--help": Boolean, "-h": "--help" }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux sync <target> <on|off>");
        console.log("  toggles tmux synchronize-panes for the target window.");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      const state = String(flags._[1] ?? "").toLowerCase();
      if (!target || !["on", "off", "true", "false", "1", "0"].includes(state)) {
        console.log("usage: maw tmux sync <target> <on|off>");
        return { ok: false, error: "target and on/off required", output: logs.join("\n") };
      }
      await deps.cmdTmuxSynchronizePanes(target, state === "on" || state === "true" || state === "1");
    } else if (sub === "attach") {
      const flags = parseFlags(args, {
        "--print": Boolean,
        "--readonly": Boolean,
        "--read-only": "--readonly",
        "-r": "--readonly",
        "--help": Boolean, "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux attach <target> [--print] [--readonly|-r]");
        console.log("  default: exec `tmux attach` (or `switch-client` inside $TMUX) when on a TTY.");
        console.log("  --readonly/-r: attach with tmux read-only client flags.");
        console.log("  --print: print the tmux command instead of exec'ing (auto-on without a TTY).");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux attach <target> [--print] [--readonly]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      deps.cmdTmuxAttach(target, { print: !!flags["--print"], readonly: !!flags["--readonly"] });
    } else if (sub === "close" || sub === "unsplit") {
      if (!process.env.TMUX) {
        console.log("\x1b[33m⚠\x1b[0m close requires tmux");
        return { ok: false, error: "not in tmux" };
      }
      const myPane = process.env.TMUX_PANE;
      const paneList = (await deps.hostExec("tmux list-panes -F '#{pane_id}'")).split("\n").filter(Boolean);
      if (paneList.length <= 1) {
        console.log("\x1b[90mno panes to close\x1b[0m");
        return { ok: true };
      }
      let hidden = 0;
      for (const pane of paneList) {
        if (pane === myPane) continue;
        try {
          await deps.hostExec(`tmux break-pane -d -t '${pane}'`);
          hidden++;
        } catch { /* already gone */ }
      }
      console.log(`\x1b[32m✓\x1b[0m closed ${hidden} pane${hidden !== 1 ? "s" : ""} (hidden — still alive)`);
    } else if (sub === "open") {
      if (!process.env.TMUX) {
        console.log("\x1b[33m⚠\x1b[0m open requires tmux");
        return { ok: false, error: "not in tmux" };
      }
      const target = args[1];
      if (!target) {
        // No target: bring back hidden panes from other windows in this session
        const myWindow = (await deps.hostExec("tmux display-message -p '#{window_index}'")).trim();
        const windowList = (await deps.hostExec("tmux list-windows -F '#{window_index}:#{window_panes}'")).split("\n").filter(Boolean);
        const hiddenWindows = windowList
          .map(l => { const [idx, count] = l.split(":"); return { idx, count: parseInt(count || "0") }; })
          .filter(w => w.idx !== myWindow && w.count === 1);
        if (hiddenWindows.length === 0) {
          console.log("\x1b[90mno hidden panes to open\x1b[0m");
          return { ok: true };
        }
        let joined = 0;
        for (const w of hiddenWindows) {
          try {
            await deps.hostExec(`tmux join-pane -h -s ':${w.idx}' -t '${myPane}'`);
            joined++;
          } catch { /* pane may have died */ }
        }
        console.log(`\x1b[32m✓\x1b[0m opened ${joined} hidden pane${joined !== 1 ? "s" : ""}`);
      } else {
        // Target given: split and show that session (same as split)
        await deps.cmdSplit(target, { lock: true });
      }
    } else if (sub === "zoom") {
      const target = args[1];
      if (!target) {
        console.log("usage: maw tmux zoom <target>");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      const { resolved } = deps.resolveTmuxTarget(target) ?? { resolved: target };
      await deps.hostExec(`tmux resize-pane -Z -t '${resolved}'`);
      console.log(`\x1b[32m✓\x1b[0m toggled zoom on ${resolved}`);

    } else if (!sub || sub === "--help" || sub === "-h") {
      console.log("usage: maw tmux <ls|peek|send|split|kill|open|close|layout|pipe|sync|attach> [args]");
      console.log("  ls [--all]              list panes with fleet + team annotations");
      console.log("  peek <target>           read content of a tmux pane");
      console.log("  send <target> <cmd>     send keys to a pane (with safety gates)");
      console.log("  split <target>          split a pane (--vertical, --pct, --cmd)");
      console.log("  kill <target>           kill a pane or --session (fleet-safe)");
      console.log("  layout <target> <preset> apply a tmux layout preset");
      console.log("  pipe <target> [cmd]      pipe pane output/input (`pipe-pane`)");
      console.log("  sync <target> <on|off>  toggle synchronize-panes");
      console.log("  attach <target> [--print] [--readonly] attach to a tmux session");
      return { ok: true, output: logs.join("\n") || undefined };
    } else {
      console.log(`unknown tmux subcommand: ${sub}`);
      console.log("usage: maw tmux <ls|peek|send|split|kill|layout|pipe|sync|attach>");
      return { ok: false, error: `unknown subcommand: ${sub}`, output: logs.join("\n") };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  };
}

export default createTmuxHandler();
