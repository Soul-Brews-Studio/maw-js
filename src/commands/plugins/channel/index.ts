import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import {
  loadOracleChannels, saveOracleChannels, listAllOracleChannels,
  loadRepoChannels, saveRepoChannels,
  type OracleChannelConfig, type ChannelPlugin,
} from "../../shared/channel-loader";
import { resolve } from "path";

export const command = {
  name: "channel",
  description: "Manage Claude Code channels per oracle.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (sub === "--help" || sub === "-h") {
      return {
        ok: true,
        output: `usage: maw channel <subcommand> [args]

subcommands:
  ls [oracle]              list channels (all or for specific oracle)
  add <oracle> <plugin>    add channel plugin to oracle
  rm <oracle> <plugin>     remove channel plugin from oracle
  providers                list available channel providers
  setup <oracle>           interactive channel setup wizard
  test <oracle>            test channel configuration
  migrate --to-repo [...]  copy global ~/.claude/channels/<oracle>/config.json
                           into each oracle's <repo>/.claude/channel.json
                           ([oracle...] empty = all; --dry-run / --remove-global)

shorthand: discord → plugin:discord@claude-plugins-official
github: prefix → delegates to setup wizard`,
      };
    }

    if (sub === "add") {
      const oracle = args[1];
      const plugin = args[2];
      if (!oracle || !plugin) {
        console.log("usage: maw channel add <oracle> <plugin-id>");
        console.log("  e.g. maw channel add hermes-discord plugin:discord@claude-plugins-official");
        console.log("       maw channel add hermes-discord discord  (shorthand)");
        return { ok: false, error: "oracle and plugin required" };
      }

      // github: provider → delegate to setup wizard
      if (plugin.startsWith("github:")) {
        const { runSetup } = await import("./setup");
        await runSetup(oracle, plugin, args.slice(3));
        return { ok: true, output: logs.join("\n") };
      }

      // #1195 Phase 1: --repo <path> writes to <repo>/.claude/channel.json
      // instead of ~/.claude/channels/<oracle>/config.json
      let repoPath: string | null = null;
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--repo" && args[i + 1]) {
          repoPath = resolve(args[i + 1]);
          break;
        }
      }

      const pluginId = expandPluginId(plugin);
      const config = (repoPath ? loadRepoChannels(repoPath) : loadOracleChannels(oracle)) || { plugins: [] };

      if (config.plugins.some(p => p.id === pluginId)) {
        console.log(`  \x1b[33m⚠\x1b[0m '${pluginId}' already registered for ${oracle}`);
        return { ok: true, output: logs.join("\n") };
      }

      const newPlugin: ChannelPlugin = { id: pluginId };

      // Auto-set DISCORD_STATE_DIR for discord plugins.
      // Per-repo (--repo): use .claude/channel-state/ relative to repo
      //                    (no homedir coupling, travels with the repo).
      // Global default:    use ~/.claude/channels/<oracle> (tilde for cross-user).
      if (pluginId.includes("discord")) {
        if (repoPath) {
          newPlugin.env = { DISCORD_STATE_DIR: ".claude/channel-state" };
        } else {
          newPlugin.env = { DISCORD_STATE_DIR: `~/.claude/channels/${oracle}` };
        }
      }

      // --env KEY=VAL, --pass, --repo (already consumed above)
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--env" && args[i + 1]?.includes("=")) {
          const [k, ...v] = args[i + 1].split("=");
          newPlugin.env = newPlugin.env || {};
          newPlugin.env[k] = v.join("=");
          i++;
        }
        if (args[i] === "--pass" && args[i + 1]) {
          config.token_source = `pass:${args[i + 1]}`;
          i++;
        }
        if (args[i] === "--repo") {
          i++; // skip the value, already consumed
        }
      }

      config.plugins.push(newPlugin);
      if (repoPath) {
        saveRepoChannels(repoPath, config);
        console.log(`  \x1b[36m📁\x1b[0m repo mode — wrote ${repoPath}/.claude/channel.json`);
      } else {
        saveOracleChannels(oracle, config);
      }

      console.log(`  \x1b[32m✅\x1b[0m channel added: ${oracle} → ${pluginId}`);
      if (newPlugin.env) {
        for (const [k, v] of Object.entries(newPlugin.env)) {
          console.log(`     env: ${k}=${v}`);
        }
      }
      if (config.token_source) {
        console.log(`     token: ${config.token_source}`);
      }
      console.log(`     next: \x1b[36mmaw wake ${oracle}\x1b[0m (channels auto-injected)`);

    } else if (sub === "rm" || sub === "remove") {
      const oracle = args[1];
      const plugin = args[2];
      if (!oracle) {
        console.log("usage: maw channel rm <oracle> [plugin-id]");
        return { ok: false, error: "oracle required" };
      }

      const config = loadOracleChannels(oracle);
      if (!config?.plugins?.length) {
        console.log(`  \x1b[90mno channels for ${oracle}\x1b[0m`);
        return { ok: true };
      }

      if (plugin) {
        const pluginId = expandPluginId(plugin);
        config.plugins = config.plugins.filter(p => p.id !== pluginId);
        saveOracleChannels(oracle, config);
        console.log(`  \x1b[32m✓\x1b[0m removed ${pluginId} from ${oracle}`);
      } else {
        config.plugins = [];
        saveOracleChannels(oracle, config);
        console.log(`  \x1b[32m✓\x1b[0m removed all channels from ${oracle}`);
      }

    } else if (sub === "ls" || sub === "list" || !sub) {
      const json = args.includes("--json");
      const target = args.filter(a => !a.startsWith("--"))[1];

      if (json) {
        const data = target
          ? { oracle: target, ...loadOracleChannels(target) }
          : { oracles: listAllOracleChannels() };
        console.log(JSON.stringify(data, null, 2));
        return { ok: true, output: logs.join("\n") || undefined };
      }

      if (target) {
        const config = loadOracleChannels(target);
        if (!config?.plugins?.length) {
          console.log(`  \x1b[90mno channels for ${target}\x1b[0m`);
        } else {
          console.log(`  \x1b[36;1m${target}\x1b[0m`);
          for (const p of config.plugins) {
            console.log(`    ${p.id}`);
            if (p.env) {
              for (const [k, v] of Object.entries(p.env)) {
                console.log(`      \x1b[90m${k}=${v}\x1b[0m`);
              }
            }
          }
          if (config.token_source) {
            console.log(`    \x1b[90mtoken: ${config.token_source}\x1b[0m`);
          }
        }
      } else {
        const all = listAllOracleChannels();
        if (all.length === 0) {
          console.log("  \x1b[90mno oracles have channels configured\x1b[0m");
          console.log("  add one: \x1b[36mmaw channel add <oracle> discord\x1b[0m");
        } else {
          console.log(`  \x1b[36;1mOracle${" ".repeat(24)}Channel\x1b[0m`);
          console.log(`  ${"─".repeat(30)}  ${"─".repeat(45)}`);
          for (const { oracle, plugins } of all) {
            for (const p of plugins) {
              console.log(`  ${oracle.padEnd(30)}  ${p.id}`);
            }
          }
          console.log(`\n  ${all.length} oracle(s) with channels`);
        }
      }

    } else if (sub === "providers") {
      const providers = getProviders();
      console.log(`  \x1b[36;1mChannel Providers\x1b[0m (${providers.length} available)\n`);
      console.log(`  ${"Provider".padEnd(15)} ${"Type".padEnd(10)} ${"Plugin ID".padEnd(45)} Status`);
      console.log(`  ${"─".repeat(15)} ${"─".repeat(10)} ${"─".repeat(45)} ${"─".repeat(10)}`);
      for (const p of providers) {
        const installed = isPluginInstalled(p.shortName);
        const status = installed ? "\x1b[32m✓ installed\x1b[0m" : "\x1b[90mnot installed\x1b[0m";
        console.log(`  ${p.shortName.padEnd(15)} ${p.type.padEnd(10)} ${p.pluginId.padEnd(45)} ${status}`);
      }
      console.log(`\n  Install: \x1b[36m/plugin install <provider>@claude-plugins-official\x1b[0m`);
      console.log(`  Custom:  \x1b[36mmaw channel add <oracle> server:<name>\x1b[0m (for .mcp.json servers)`);

    } else if (sub === "setup") {
      const { runSetup } = await import("./setup");
      await runSetup(args[1], args[2], args.slice(3));

    } else if (sub === "test") {
      const target = args[1];
      if (!target) {
        console.log("  usage: maw channel test <oracle>");
        return { ok: false, error: "oracle required" };
      }
      const config = loadOracleChannels(target);
      if (!config?.plugins?.length) {
        console.log(`  \x1b[31m✗\x1b[0m no channels for ${target}`);
        return { ok: false, error: "no channels" };
      }
      console.log(`  \x1b[36;1mChannel Test: ${target}\x1b[0m\n`);
      const { getChannelEnv } = await import("../../shared/channel-loader");
      const env = getChannelEnv(target);
      for (const p of config.plugins) {
        const checks: string[] = [];
        // Check plugin installed
        if (p.id.startsWith("plugin:")) {
          const name = p.id.split(":")[1]?.split("@")[0];
          if (name && isPluginInstalled(name)) checks.push("\x1b[32m✓ plugin installed\x1b[0m");
          else checks.push("\x1b[31m✗ plugin not installed\x1b[0m");
        }
        // Check state dir
        if (p.env?.DISCORD_STATE_DIR || env.DISCORD_STATE_DIR) {
          const dir = env.DISCORD_STATE_DIR || p.env?.DISCORD_STATE_DIR || "";
          const { existsSync: ex } = require("fs");
          if (ex(dir)) checks.push(`\x1b[32m✓ state dir exists\x1b[0m`);
          else checks.push(`\x1b[31m✗ state dir missing: ${dir}\x1b[0m`);
        }
        // Check token
        if (env.DISCORD_BOT_TOKEN) checks.push("\x1b[32m✓ token available\x1b[0m");
        else if (env.TELEGRAM_BOT_TOKEN) checks.push("\x1b[32m✓ token available\x1b[0m");
        else if (config.token_source) checks.push(`\x1b[32m✓ token source: ${config.token_source}\x1b[0m`);
        else checks.push("\x1b[33m⚠ no token configured\x1b[0m");
        // Check source (git channels)
        if ((p as any).source) {
          const { existsSync: ex } = require("fs");
          if ((p as any).path && ex((p as any).path)) checks.push(`\x1b[32m✓ repo cloned\x1b[0m`);
          else checks.push(`\x1b[31m✗ repo not cloned\x1b[0m`);
        }

        const devTag = (p as any).dev ? " \x1b[33m[dev]\x1b[0m" : "";
        console.log(`  ${p.id}${devTag}`);
        for (const c of checks) console.log(`    ${c}`);
      }

    } else if (sub === "migrate") {
      const rest = args.slice(1);
      const toRepo = rest.includes("--to-repo");
      const dryRun = rest.includes("--dry-run");
      const removeGlobal = rest.includes("--remove-global");
      const targets = rest.filter(a => !a.startsWith("--"));

      if (!toRepo) {
        console.log("usage: maw channel migrate --to-repo [oracle...] [--dry-run] [--remove-global]");
        console.log("  copies global ~/.claude/channels/<oracle>/config.json into");
        console.log("  <repo>/.claude/channel.json so config travels with the repo (#1195).");
        console.log("");
        console.log("  no [oracle...] args = migrate every oracle with global config.");
        console.log("  --dry-run            = show what would happen, no writes.");
        console.log("  --remove-global      = delete the global config after a successful copy.");
        return { ok: false, error: "--to-repo required" };
      }

      const stems = targets.length > 0
        ? targets
        : listAllOracleChannels().map(o => o.oracle);

      if (stems.length === 0) {
        console.log("  no oracles with global channel config to migrate");
        return { ok: true };
      }

      const { ghqFind } = await import("../../../core/ghq");
      const { unlinkSync, rmdirSync } = await import("fs");
      const { join: pathJoin } = await import("path");
      const { homedir: hd } = await import("os");

      // Channel dir names are heterogeneous: some include the `-oracle`
      // suffix (e.g. `mawjs-oracle`), some don't (e.g. `mother`,
      // `hermes-discord`). Try the literal name first, then the
      // `-oracle`-suffixed form, then the stripped form. ghqFind returns
      // the FIRST match (and warns on multiples) without calling
      // process.exit — unlike resolveOracle.
      const resolveRepo = async (stem: string): Promise<string | null> => {
        const candidates = [
          stem,
          stem.endsWith("-oracle") ? stem.replace(/-oracle$/, "") : `${stem}-oracle`,
        ];
        for (const candidate of candidates) {
          const hit = await ghqFind(`/${candidate}`);
          if (hit) return hit;
        }
        return null;
      };

      let migrated = 0, skipped = 0, failed = 0;
      for (const stem of stems) {
        const global = loadOracleChannels(stem);
        if (!global) {
          console.log(`  \x1b[90m·\x1b[0m ${stem}: no global config — skip`);
          skipped++;
          continue;
        }

        const repoPath = await resolveRepo(stem);
        if (!repoPath) {
          console.log(`  \x1b[31m✗\x1b[0m ${stem}: no local repo (tried ghq for '${stem}' and '-oracle' variants) — skip`);
          failed++;
          continue;
        }

        if (loadRepoChannels(repoPath)) {
          console.log(`  \x1b[33m⚠\x1b[0m ${stem}: ${repoPath}/.claude/channel.json already exists — skip (delete it first)`);
          skipped++;
          continue;
        }

        if (dryRun) {
          console.log(`  \x1b[36m·\x1b[0m DRY-RUN ${stem}: would write ${repoPath}/.claude/channel.json (${global.plugins.length} plugin(s))`);
          migrated++;
          continue;
        }

        saveRepoChannels(repoPath, global);
        console.log(`  \x1b[32m✓\x1b[0m ${stem}: → ${repoPath}/.claude/channel.json`);

        if (removeGlobal) {
          const globalConfig = pathJoin(hd(), ".claude", "channels", stem, "config.json");
          const globalDir = pathJoin(hd(), ".claude", "channels", stem);
          try {
            unlinkSync(globalConfig);
            try { rmdirSync(globalDir); } catch { /* dir not empty: state files survive */ }
            console.log(`    \x1b[90m✓ removed global config\x1b[0m`);
          } catch (e: any) {
            console.log(`    \x1b[33m⚠ failed to remove global: ${e?.message || e}\x1b[0m`);
          }
        }
        migrated++;
      }

      console.log(`\n  ${migrated} migrated, ${skipped} skipped, ${failed} failed`);
      if (migrated > 0 && !removeGlobal && !dryRun) {
        console.log(`  tip: re-run with --remove-global to delete the global config copies.`);
      }

    } else {
      console.log("usage: maw channel <add|rm|ls|providers|setup|test|migrate> [oracle] [plugin]\n");
      console.log("  maw channel providers                          list available providers");
      console.log("  maw channel setup hermes-discord discord       interactive wizard");
      console.log("  maw channel setup myoracle github:org/repo     git channel wizard");
      console.log("  maw channel add hermes-discord discord         quick register");
      console.log("  maw channel add myoracle github:org/repo       git channel");
      console.log("  maw channel rm hermes-discord discord          remove channel");
      console.log("  maw channel ls                                 list all");
      console.log("  maw channel test hermes-discord                verify connectivity");
      console.log("  maw channel migrate --to-repo [oracle...]      global → repo (#1195)");
      console.log("");
      console.log("  maw wake <oracle> auto-injects --channels when config exists");
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}

function expandPluginId(short: string): string {
  if (short.includes(":") || short.includes("@")) return short;
  return `plugin:${short}@claude-plugins-official`;
}

interface Provider {
  shortName: string;
  pluginId: string;
  type: "chat" | "webhook" | "custom";
}

function getProviders(): Provider[] {
  const official: Provider[] = [
    { shortName: "discord", pluginId: "plugin:discord@claude-plugins-official", type: "chat" },
    { shortName: "telegram", pluginId: "plugin:telegram@claude-plugins-official", type: "chat" },
    { shortName: "imessage", pluginId: "plugin:imessage@claude-plugins-official", type: "chat" },
    { shortName: "fakechat", pluginId: "plugin:fakechat@claude-plugins-official", type: "chat" },
  ];

  // Scan for custom channels in .mcp.json
  const { existsSync, readFileSync } = require("fs");
  const { join } = require("path");
  const mcpPaths = [
    join(process.cwd(), ".mcp.json"),
    join(require("os").homedir(), ".claude.json"),
  ];

  for (const p of mcpPaths) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      const servers = data.mcpServers || {};
      for (const [name, _config] of Object.entries(servers)) {
        official.push({ shortName: name, pluginId: `server:${name}`, type: "custom" });
      }
    } catch { /* skip malformed */ }
  }

  return official;
}

function isPluginInstalled(shortName: string): boolean {
  const { existsSync } = require("fs");
  const { join } = require("path");
  const pluginDir = join(require("os").homedir(), ".claude/plugins/cache/claude-plugins-official", shortName);
  return existsSync(pluginDir);
}
