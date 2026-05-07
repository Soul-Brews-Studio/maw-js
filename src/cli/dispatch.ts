import { cmdPeek, cmdSend } from "../commands/shared/comm";
import { routeComm } from "./route-comm";
import { routeTools } from "./route-tools";
import { matchCommand, executeCommand } from "./command-registry";
import { getVersionString } from "./cmd-version";
import { runUpdate } from "./cmd-update";
import { UserError } from "../core/util/user-error";
import { formatError } from "../lib/format-error";

/** Core route names that are not plugins but are still "known commands". */
const CORE_ROUTES = [
  "hey",
  "plugins", "plugin", "artifacts", "artifact",
  "agents", "agent", "audit", "serve",
  "update", "upgrade", "version",
];

/**
 * Run a command after plugins have been scanned. Walks the dispatch ladder:
 *   routeComm → routeTools → top-aliases → plugin registry (beta) →
 *   bundled plugin registry → agent-name shorthand.
 *
 * Throws UserError for ambiguous/unknown commands. Exits the process on
 * successful plugin invocation (preserves prior behavior).
 */
export async function dispatchCommand(cmd: string, args: string[]): Promise<void> {
  const handled =
    (await routeComm(cmd, args)) ||
    (await routeTools(cmd, args));
  if (handled) return;

  // RFC #954 — top-level verb aliases. Sits between routeTools and
  // matchCommand. Either rewrites argv in place (continue dispatch flow)
  // or dispatches a direct-handler and exits the pipeline.
  const { resolveTopAlias, invokeDirectHandler } = await import("./top-aliases");
  const aliasResult = resolveTopAlias(args);
  if (aliasResult) {
    if (aliasResult.kind === "direct") {
      await invokeDirectHandler(aliasResult.handler, aliasResult.argv);
      return;
    }
    args.splice(0, args.length, ...aliasResult.argv);
  }

  // Try plugin commands (beta) — after core routes, before fallback
  const pluginMatch = matchCommand(args);
  if (pluginMatch) {
    await executeCommand(pluginMatch.desc, pluginMatch.remaining);
    return;
  }

  // Fallback: check plugin registry for bundled commands
  await dispatchPluginRegistry(cmd, args);
}

/**
 * Bundled plugin registry dispatch + unknown-command handling.
 *
 * #349/#351/#354 — prefix match MUST require word boundary. Loose
 * `startsWith(n)` lets alias "rest" of stop plugin match "restart --help"
 * and invoke destructive cmdSleep. Fix: require exact OR `n + " "` prefix.
 *
 * #393 Bug H: lowercase ONLY for plugin-name matching. Pass ORIGINAL-case
 * args to the plugin so team names, subjects, paths stay case-correct.
 */
async function dispatchPluginRegistry(cmd: string, args: string[]): Promise<void> {
  const { discoverPackages, invokePlugin } = await import("../plugin/registry");
  const { resolvePluginMatch, pluginCliNames } = await import("./dispatch-match");
  const plugins = discoverPackages();
  const cmdName = args.join(" ").toLowerCase();
  const dispatch = resolvePluginMatch(plugins, cmdName);

  if (dispatch.kind === "ambiguous") {
    console.error(formatError(
      `ambiguous command: ${args[0]}`,
      `candidates: ${dispatch.candidates.map(c => `${c.plugin} (${c.name})`).join(", ")}`,
    ));
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
  const { listCommands } = await import("./command-registry");
  for (const c of listCommands()) {
    const names = Array.isArray(c.name) ? c.name : [c.name];
    for (const n of names) knownCommands.push(n);
  }
  const isKnownCommand = knownCommands.some(n => n.toLowerCase() === cmd);
  if (!isKnownCommand) {
    // Prefix auto-resolve: if input uniquely prefixes one known command, run it.
    // e.g. "v" → "version", "up" → "update", "cl" → "cleanup"
    const prefixMatches = knownCommands.filter(n => n.toLowerCase().startsWith(cmd) && n.toLowerCase() !== cmd);
    const uniquePrefixes = [...new Set(prefixMatches.map(n => n.toLowerCase()))];
    if (uniquePrefixes.length === 1) {
      const resolved = prefixMatches[0];
      args.splice(0, 1, resolved);
      const retryMatch = matchCommand(args);
      if (retryMatch) {
        await executeCommand(retryMatch.desc, retryMatch.remaining);
        process.exit(0);
      }
      const retryPlugin = resolvePluginMatch(plugins, args.join(" ").toLowerCase());
      if (retryPlugin.kind === "match") {
        const matchedWords = retryPlugin.matchedName.split(/\s+/).filter(Boolean).length;
        const result = await invokePlugin(retryPlugin.plugin, { source: "cli", args: args.slice(matchedWords) });
        if (result.ok && result.output) console.log(result.output);
        else if (!result.ok) { console.error(result.error); process.exit(result.exitCode ?? 1); }
        process.exit(0);
      }
      // Special case: core routes handled before plugin dispatch
      if (resolved === "version") { console.log(getVersionString()); process.exit(0); }
      if (resolved === "update" || resolved === "upgrade") { await runUpdate(args.slice(1)); process.exit(0); }
    }

    // #394 — fuzzy FIRST, tmux listSessions second.
    const { fuzzyMatch } = await import("../core/util/fuzzy");
    const closeCandidates = uniquePrefixes.length > 1
      ? uniquePrefixes
      : fuzzyMatch(args[0], knownCommands, 3, 2);
    let isOracle = false;
    if (closeCandidates.length === 0) {
      // No close typo-match. Only spend the tmux query if the arg
      // shape is plausibly an oracle session name.
      const ORACLE_NAME_SHAPE = /^[a-z0-9][a-z0-9:_-]*$/i;
      if (ORACLE_NAME_SHAPE.test(args[0])) {
        const { listSessions } = await import("../sdk");
        const sessions = await listSessions().catch(() => [] as Awaited<ReturnType<typeof listSessions>>);
        const target = args[0].toLowerCase();
        isOracle = sessions.some(s => {
          const name = s.name.toLowerCase();
          return name === target || name.replace(/^\d+-/, "") === target;
        });
      }
    }
    if (!isOracle) {
      const hint = closeCandidates.length > 0
        ? `did you mean: ${closeCandidates.join(", ")}?`
        : `run 'maw --help' to see available commands`;
      console.error(formatError(`unknown command: ${args[0]}`, hint));
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
