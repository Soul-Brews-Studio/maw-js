#!/usr/bin/env bun
process.env.MAW_CLI = "1";

// #566: apply --as <name> BEFORE any state-touching import (paths.ts evaluates
// MAW_HOME at module load). Must be the first side effect.
import { applyInstancePreset } from "./cli/instance-preset";
applyInstancePreset();

import { cmdPeek, cmdSend } from "./commands/shared/comm";
import { logAudit } from "./core/fleet/audit";
import { usage } from "./cli/usage";
import { routeComm } from "./cli/route-comm";
import { routeTools } from "./cli/route-tools";
import { scanCommands, matchCommand, executeCommand } from "./cli/command-registry";
import { setVerbosityFlags } from "./cli/verbosity";
import { getVersionString } from "./cli/cmd-version";
import { runUpdate } from "./cli/cmd-update";
import { runBootstrap } from "./cli/plugin-bootstrap";
import { UserError, isUserError } from "./core/util/user-error";
import { AmbiguousMatchError } from "./core/runtime/find-window";
import { renderAmbiguousMatch } from "./core/util/render-ambiguous";
import { join } from "path";
import { homedir } from "os";

// Strip verbosity flags up-front so they don't collide with cmd detection or
// leak into plugin argv. Task #3 will flip call sites to honor these.
const VERBOSITY_FLAGS = new Set(["--quiet", "-q", "--silent", "-s"]);
const rawArgs = process.argv.slice(2);
const verbosity: { quiet?: boolean; silent?: boolean } = {};
if (rawArgs.some(a => a === "--quiet" || a === "-q")) verbosity.quiet = true;
if (rawArgs.some(a => a === "--silent" || a === "-s")) verbosity.silent = true;
setVerbosityFlags(verbosity);
const args = rawArgs.filter(a => !VERBOSITY_FLAGS.has(a));
const cmd = args[0]?.toLowerCase();

logAudit(cmd || "", args);

async function main(): Promise<void> {
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(getVersionString());
  } else if (cmd === "update" || cmd === "upgrade") {
    await runUpdate(args);
  } else {
    // Auto-bootstrap: if ~/.maw/plugins/ is empty, symlink bundled + install from pluginSources
    const pluginDir = join(homedir(), ".maw", "plugins");
    await runBootstrap(pluginDir, import.meta.dir);

    // Load plugins from ~/.maw/plugins/ — the single source of truth
    await scanCommands(pluginDir, "user");

    if (!cmd || cmd === "--help" || cmd === "-h") {
      usage();
    } else {

    // Core routes: hey (transport) + plugin management + serve
    const handled =
      await routeComm(cmd, args) ||
      await routeTools(cmd, args);

    if (!handled) {
      // Try plugin commands (beta) — after core routes, before fallback
      const pluginMatch = matchCommand(args);
      if (pluginMatch) {
        await executeCommand(pluginMatch.desc, pluginMatch.remaining);
      } else {
        // Fallback: check plugin registry for bundled commands
        // #349/#351/#354 — prefix match MUST require word boundary. Loose
        // `startsWith(n)` lets alias "rest" of stop plugin match "restart --help"
        // and invoke destructive cmdSleep. Fix: require exact OR `n + " "` prefix.
        // Also: slice by the MATCHED name (alias or command), not always command,
        // so remaining args are computed correctly when an alias fires.
        const { discoverPackages, invokePlugin } = await import("./plugin/registry");
        const { resolvePluginMatch, pluginCliNames } = await import("./cli/dispatch-match");
        const plugins = discoverPackages();
        // #393 Bug H: use lowercased cmdName ONLY for plugin-name matching.
        // Pass the ORIGINAL-case args to the plugin. Previously remaining was
        // sliced off the lowercased cmdName, which silently lowercased team
        // names, subjects, paths, and any case-sensitive arg.
        const cmdName = args.join(" ").toLowerCase();
        const dispatch = resolvePluginMatch(plugins, cmdName);
        if (dispatch.kind === "ambiguous") {
          console.error(`\x1b[31m✗\x1b[0m ambiguous command: ${args[0]}`);
          console.error(`  candidates: ${dispatch.candidates.map(c => `${c.plugin} (${c.name})`).join(", ")}`);
          throw new UserError(`ambiguous command: ${args[0]}`);
        }
        if (dispatch.kind === "match") {
          const matchedWords = dispatch.matchedName.split(/\s+/).filter(Boolean).length;
          const remaining = args.slice(matchedWords);
          const result = await invokePlugin(dispatch.plugin, { source: "cli", args: remaining });
          if (result.ok && result.output) console.log(result.output);
          else if (!result.ok) { console.error(result.error); process.exit(result.exitCode ?? 1); }
          process.exit(0);
        }
        // #388.2 — unknown command: fuzzy-suggest against the plugin registry.
        // Only intercepts when cmd is NOT a known route/plugin/alias AND does
        // NOT strictly match an oracle session name. Preserves `maw mawjs`
        // shorthand while catching `maw hek` / `maw oracl` / typos.
        const CORE_ROUTES = [
          "hey",
          "plugins", "plugin", "artifacts", "artifact",
          "agents", "agent", "audit", "serve",
          "update", "upgrade", "version",
        ];
        const knownCommands: string[] = [...CORE_ROUTES];
        for (const p of plugins) {
          // #899 — mirror dispatch-match's default-name behavior: plugins
          // without `cli` but with a dispatchable entry surface as
          // `manifest.name`. Keeps the unknown-command guard in sync with
          // the dispatcher so source-installed community plugins don't
          // trigger "did you mean" suggestions for their own command.
          const cliNames = pluginCliNames(p);
          if (!cliNames) continue;
          knownCommands.push(cliNames.command);
          for (const a of cliNames.aliases) knownCommands.push(a);
        }
        const { listCommands } = await import("./cli/command-registry");
        for (const c of listCommands()) {
          const names = Array.isArray(c.name) ? c.name : [c.name];
          for (const n of names) knownCommands.push(n);
        }
        const isKnownCommand = knownCommands.some(n => n.toLowerCase() === cmd);
        if (!isKnownCommand) {
          // #394 — fuzzy FIRST, tmux listSessions second. The old order paid
          // ~40ms on every unknown arg even when it was clearly a typo of a
          // known command. New flow:
          //   1. fuzzy-match against knownCommands (distance ≤ 2)
          //   2. if close candidates → "did you mean" + exit, skip tmux
          //   3. else if arg has oracle-name shape → tmux listSessions
          //   4. else → generic "run maw --help"
          const { fuzzyMatch } = await import("./core/util/fuzzy");
          const closeCandidates = fuzzyMatch(args[0], knownCommands, 3, 2);
          let isOracle = false;
          if (closeCandidates.length === 0) {
            // No close typo-match. Only spend the tmux query if the arg
            // shape is plausibly an oracle session name.
            const ORACLE_NAME_SHAPE = /^[a-z0-9][a-z0-9:_-]*$/i;
            if (ORACLE_NAME_SHAPE.test(args[0])) {
              const { listSessions } = await import("./sdk");
              const sessions = await listSessions().catch(() => [] as Awaited<ReturnType<typeof listSessions>>);
              const target = args[0].toLowerCase();
              isOracle = sessions.some(s => {
                const name = s.name.toLowerCase();
                return name === target || name.replace(/^\d+-/, "") === target;
              });
            }
          }
          if (!isOracle) {
            console.error(`\x1b[31m✗\x1b[0m unknown command: ${args[0]}`);
            if (closeCandidates.length > 0) {
              console.error(`  did you mean: ${closeCandidates.join(", ")}?`);
            } else {
              console.error(`  run 'maw --help' to see available commands`);
            }
            // UserError: output already printed above; top-level catch just
            // exits 1 without bun's default stack trace (alpha.66 polish).
            throw new UserError(`unknown command: ${args[0]}`);
          }
        }
        // Default: agent name shorthand (maw <agent> <msg> or maw <agent>)
        if (args.length >= 2) {
          const f = args.includes("--force");
          const m = args.slice(1).filter(a => a !== "--force");
          await cmdSend(args[0], m.join(" "), f);
        } else {
          await cmdPeek(args[0]);
        }
      }
    }
    }
  }
}

// Top-level error handler (#388 polish): suppress bun's default stack trace
// for UserError — the throw site already printed user-facing output. Real
// bugs still surface their full stack so we can debug them.
main().catch((e: unknown) => {
  if (isUserError(e)) {
    process.exit(1);
  }
  // #567 — AmbiguousMatchError escapes from findWindow via resolver chains
  // (cmdSend, cmdPeek, talk-to, view, etc.). Render it as actionable CLI
  // output instead of a minified stack trace. Exit 1 preserved.
  if (e instanceof AmbiguousMatchError) {
    console.error(renderAmbiguousMatch(e, args));
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
