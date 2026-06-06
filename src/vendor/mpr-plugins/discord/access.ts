/**
 * `maw discord access <bot> ...` — channel + allowlist management per bot.
 *
 * Design: WRAP the global `discord-access` CLI (which lives in the discord-oracle
 * repo, exposed via `bun link`). Don't reinvent. Add the missing flags
 * (`--no-mention`, `--allow`, multi-guild `--refresh`) via post-processing the
 * access.json the raw tool emits.
 *
 * Per-bot resolution: <bot> → state-dirs.ts entry → DISCORD_STATE_DIR env →
 * discord-access reads access.json from there.
 *
 * Subcommands:
 *   list                                 show enabled channels for <bot>
 *   show <channel>                       inspect one channel's config
 *   map [--guild <id>] [--refresh]       list/refresh channel-map.json
 *   add <channel> [--no-mention] [--allow <id>...]
 *                                        enable channel + optional flags
 *   rm <channel> [--dry-run]             remove channel access
 *   set <channel> [--no-mention|--mention] [--allow <id>...]
 *                                        toggle existing channel without rm+add
 *   allow <add|rm|ls> [<user-id>]        global DM allowlist management
 *   lockdown [--off] [--dry-run]         dmPolicy=allowlist (or revert)
 *
 * Output: action lines for mutations, table for list/show/map, --json for piping.
 */
import { hostExec } from "maw-js/sdk";
import { findHybridDiscord, findLegacyStateDir, loadStateDirsRegistry, listPassTokens, decryptToken } from "./lib";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface BotResolved {
  bot: string;
  stateDir: string;
  tokenName: string;
  isHybrid: boolean;
  accessJson: string;
  channelMap: string;
}

async function resolveBot(log: (s: string) => void, bot: string): Promise<BotResolved | null> {
  const registry = await loadStateDirsRegistry();
  const hybrid = await findHybridDiscord(bot);
  const legacy = findLegacyStateDir(bot);
  const stateDir = hybrid || legacy;
  if (!stateDir) {
    log(`✗ no state-dir found for '${bot}' (checked hybrid <repo>/.discord/ and ${process.env.HOME}/.claude/channels/${bot}/)`);
    return null;
  }
  const tokens = listPassTokens();
  const tokEntry = tokens.find(t => t.bot === bot);
  if (!tokEntry) {
    log(`✗ no pass entry for '${bot}' (looked for discord/${bot}-token.gpg)`);
    return null;
  }
  if (!registry.has(bot)) {
    log(`⚠ '${bot}' not in discord-oracle/src/state-dirs.ts — dashboard won't see it`);
  }
  return {
    bot,
    stateDir,
    tokenName: tokEntry.name,
    isHybrid: !!hybrid,
    accessJson: join(stateDir, "access.json"),
    channelMap: join(stateDir, "channel-map.json"),
  };
}

function loadAccess(path: string): any {
  if (!existsSync(path)) {
    return { dmPolicy: "allowlist", allowFrom: [], groups: {}, pending: {} };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveAccess(path: string, data: any): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function loadChannelMap(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveChannel(map: Record<string, string>, name: string): string | null {
  if (/^\d+$/.test(name)) return name; // already an id
  return map[name] ?? null;
}

async function execDiscordAccess(pre: BotResolved, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const token = await decryptToken(pre.tokenName);
  if (!token) throw new Error(`pass decrypt failed for ${pre.tokenName}`);
  const env = [
    `DISCORD_STATE_DIR=${pre.stateDir}`,
    `DISCORD_BOT_TOKEN=${token}`,
    `DISCORD_USER_ID=${extraEnv.DISCORD_USER_ID || process.env.DISCORD_USER_ID || "691531480689541170"}`,
    ...(extraEnv.DISCORD_GUILD_ID ? [`DISCORD_GUILD_ID=${extraEnv.DISCORD_GUILD_ID}`] : []),
  ].join(" ");
  const cmd = `${env} discord-access ${args.join(" ")} 2>&1`;
  return await hostExec(cmd);
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean | string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-mention") flags.noMention = true;
    else if (a === "--mention") flags.mention = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--refresh") flags.refresh = true;
    else if (a === "--off") flags.off = true;
    else if (a === "--guild") flags.guild = args[++i] ?? "";
    else if (a === "--allow") {
      const cur = (flags.allow as string[] | undefined) ?? [];
      cur.push(args[++i] ?? "");
      flags.allow = cur;
    } else positional.push(a);
  }
  return { positional, flags };
}

export const cmdAccess = {
  async run(log: (s: string) => void, args: string[]): Promise<void> {
    if (args.length === 0) {
      this.printUsage(log);
      return;
    }
    const bot = args[0]!;
    const sub = (args[1] || "").toLowerCase();
    const rest = args.slice(2);

    if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
      this.printUsage(log);
      return;
    }

    const pre = await resolveBot(log, bot);
    if (!pre) return;

    log(`🪪 maw discord access ${bot} ${sub}${rest.length ? " " + rest.join(" ") : ""}`);
    log(`  state-dir: ${pre.stateDir}${pre.isHybrid ? " (hybrid)" : " (legacy)"}`);
    log("");

    switch (sub) {
      case "list":      return this.list(log, pre, rest);
      case "show":      return this.show(log, pre, rest);
      case "map":       return this.map(log, pre, rest);
      case "add":       return this.add(log, pre, rest);
      case "rm":        return this.rm(log, pre, rest);
      case "set":       return this.set(log, pre, rest);
      case "allow":     return this.allow(log, pre, rest);
      case "lockdown":  return this.lockdown(log, pre, rest);
      default:
        log(`✗ unknown subcommand: ${sub}`);
        this.printUsage(log);
        return;
    }
  },

  printUsage(log: (s: string) => void): void {
    log("usage: maw discord access <bot> <subcommand> [args]");
    log("");
    log("subcommands:");
    log("  list [--json]                       enabled channels for <bot>");
    log("  show <channel> [--json]             inspect one channel's config");
    log("  map [--guild <id>] [--refresh]      channel-map (name → id), --refresh from Discord");
    log("  add <channel> [--no-mention] [--allow <id>...]");
    log("                                      enable channel access");
    log("  rm <channel> [--dry-run]            remove channel access");
    log("  set <channel> [--no-mention|--mention] [--allow <id>...]");
    log("                                      toggle existing channel without rm+add");
    log("  allow <add|rm|ls> [<user-id>]       global DM allowlist management");
    log("  lockdown [--off] [--dry-run]        dmPolicy=allowlist (or revert with --off)");
  },

  async list(log: (s: string) => void, pre: BotResolved, args: string[]): Promise<void> {
    const { flags } = parseFlags(args);
    const access = loadAccess(pre.accessJson);
    const map = loadChannelMap(pre.channelMap);
    const reverseMap: Record<string, string> = {};
    for (const [name, id] of Object.entries(map)) reverseMap[id] = name;

    const groups = access.groups || {};
    const entries = Object.entries(groups).map(([id, cfg]: [string, any]) => ({
      id,
      name: reverseMap[id] || "(unknown)",
      requireMention: cfg.requireMention,
      allowFrom: cfg.allowFrom || [],
    }));

    if (flags.json) {
      log(JSON.stringify({ bot: pre.bot, channels: entries }, null, 2));
      return;
    }

    if (entries.length === 0) {
      log("  (no channels enabled)");
      return;
    }
    log(`  ${entries.length} channel(s):`);
    log("");
    log("  channel-name                     id                    mention  allowFrom");
    log("  ─────────────────────────────────────────────────────────────────────────");
    for (const e of entries) {
      const name = e.name.padEnd(32);
      const id = e.id.padEnd(20);
      const m = e.requireMention ? "✓ tag  " : "○ all  ";
      const allow = e.allowFrom.length ? e.allowFrom.join(",") : "(none)";
      log(`  ${name} ${id}  ${m}  ${allow}`);
    }
  },

  async show(log: (s: string) => void, pre: BotResolved, args: string[]): Promise<void> {
    const { positional, flags } = parseFlags(args);
    const channelArg = positional[0];
    if (!channelArg) {
      log("usage: maw discord access <bot> show <channel> [--json]");
      return;
    }
    const map = loadChannelMap(pre.channelMap);
    const id = resolveChannel(map, channelArg);
    if (!id) {
      log(`✗ channel '${channelArg}' not in channel-map (run 'access map --refresh')`);
      return;
    }
    const access = loadAccess(pre.accessJson);
    const cfg = access.groups?.[id];
    if (!cfg) {
      log(`✗ channel '${channelArg}' (${id}) not in access.json`);
      return;
    }
    const reverseMap: Record<string, string> = {};
    for (const [name, mapId] of Object.entries(map)) reverseMap[mapId] = name;
    const out = {
      bot: pre.bot,
      channel: { id, name: reverseMap[id] || "(unknown)" },
      requireMention: cfg.requireMention,
      allowFrom: cfg.allowFrom || [],
    };
    if (flags.json) {
      log(JSON.stringify(out, null, 2));
      return;
    }
    log(`  #${out.channel.name} (${id})`);
    log(`    requireMention: ${out.requireMention}`);
    log(`    allowFrom:      ${out.allowFrom.join(", ") || "(none)"}`);
  },

  async map(log: (s: string) => void, pre: BotResolved, args: string[]): Promise<void> {
    const { flags } = parseFlags(args);
    if (flags.refresh) {
      log("  refreshing channel-map from Discord...");
      const out = await execDiscordAccess(pre, ["refresh"], flags.guild ? { DISCORD_GUILD_ID: flags.guild as string } : {});
      log(out.split("\n").map(l => `    ${l}`).join("\n"));
      log("");
    }
    const map = loadChannelMap(pre.channelMap);
    const entries = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
      log("  (no channels mapped — run with --refresh --guild <id>)");
      return;
    }
    log(`  ${entries.length} channel(s) in map:`);
    log("");
    log("  channel-name                     id");
    log("  ──────────────────────────────────────────────");
    for (const [name, id] of entries) {
      log(`  ${name.padEnd(32)} ${id}`);
    }
  },

  async add(log: (s: string) => void, pre: BotResolved, args: string[]): Promise<void> {
    const { positional, flags } = parseFlags(args);
    const channelArg = positional[0];
    if (!channelArg) {
      log("usage: maw discord access <bot> add <channel> [--no-mention] [--allow <id>...]");
      return;
    }
    const map = loadChannelMap(pre.channelMap);
    const id = resolveChannel(map, channelArg);
    if (!id) {
      log(`✗ channel '${channelArg}' not in channel-map`);
      log(`  run 'maw discord access ${pre.bot} map --refresh' first`);
      return;
    }
    // Delegate add to discord-access (handles channel-name resolution + access.json create)
    const reverseMap: Record<string, string> = {};
    for (const [name, mapId] of Object.entries(map)) reverseMap[mapId] = name;
    const channelName = reverseMap[id] || channelArg;
    const out = await execDiscordAccess(pre, ["add", channelName]);
    log(out.split("\n").map(l => `    ${l}`).join("\n"));

    // Post-process for missing flags
    const access = loadAccess(pre.accessJson);
    if (!access.groups[id]) {
      log(`✗ post-add check: access.json missing groups[${id}] — discord-access may have failed`);
      return;
    }
    const before = JSON.stringify(access.groups[id]);
    if (flags.noMention) {
      access.groups[id].requireMention = false;
    }
    if (flags.allow && (flags.allow as string[]).length > 0) {
      access.groups[id].allowFrom = flags.allow as string[];
    }
    const after = JSON.stringify(access.groups[id]);
    if (before !== after) {
      saveAccess(pre.accessJson, access);
      log(`  ✓ flags applied: ${flags.noMention ? "mention=false " : ""}${flags.allow ? `allow=[${(flags.allow as string[]).join(",")}]` : ""}`);
    } else {
      log("  (defaults applied: requireMention=true, allowFrom=[$DISCORD_USER_ID])");
    }
  },

  async rm(log: (s: string) => void, pre: BotResolved, args: string[]): Promise<void> {
    const { positional, flags } = parseFlags(args);
    const channelArg = positional[0];
    if (!channelArg) {
      log("usage: maw discord access <bot> rm <channel> [--dry-run]");
      return;
    }
    const map = loadChannelMap(pre.channelMap);
    const id = resolveChannel(map, channelArg);
    if (!id) {
      log(`✗ channel '${channelArg}' not in channel-map`);
      return;
    }
    const reverseMap: Record<string, string> = {};
    for (const [name, mapId] of Object.entries(map)) reverseMap[mapId] = name;
    const channelName = reverseMap[id] || channelArg;
    const access = loadAccess(pre.accessJson);
    if (!access.groups?.[id]) {
      log(`✗ channel '${channelName}' not currently enabled`);
      return;
    }
    if (flags.dryRun) {
      log(`  [dry-run] would remove #${channelName} (${id}) from access`);
      log(`            current config: ${JSON.stringify(access.groups[id])}`);
      return;
    }
    const out = await execDiscordAccess(pre, ["rm", channelName]);
    log(out.split("\n").map(l => `    ${l}`).join("\n"));
  },

  async set(log: (s: string) => void, pre: BotResolved, args: string[]): Promise<void> {
    const { positional, flags } = parseFlags(args);
    const channelArg = positional[0];
    if (!channelArg) {
      log("usage: maw discord access <bot> set <channel> [--no-mention|--mention] [--allow <id>...]");
      return;
    }
    const map = loadChannelMap(pre.channelMap);
    const id = resolveChannel(map, channelArg);
    if (!id) {
      log(`✗ channel '${channelArg}' not in channel-map`);
      return;
    }
    const access = loadAccess(pre.accessJson);
    if (!access.groups?.[id]) {
      log(`✗ channel not currently enabled — use 'add' instead`);
      return;
    }
    const before = JSON.stringify(access.groups[id]);
    if (flags.noMention) access.groups[id].requireMention = false;
    if (flags.mention) access.groups[id].requireMention = true;
    if (flags.allow && (flags.allow as string[]).length > 0) {
      access.groups[id].allowFrom = flags.allow as string[];
    }
    const after = JSON.stringify(access.groups[id]);
    if (before === after) {
      log("  ○ no changes — already configured as requested");
      return;
    }
    saveAccess(pre.accessJson, access);
    log(`  ✓ updated: ${access.groups[id].requireMention ? "mention=true " : "mention=false "}allow=[${access.groups[id].allowFrom.join(",")}]`);
  },

  async allow(log: (s: string) => void, pre: BotResolved, args: string[]): Promise<void> {
    const action = (args[0] || "").toLowerCase();
    const userId = args[1];
    if (!action || !["add", "rm", "ls"].includes(action)) {
      log("usage: maw discord access <bot> allow <add|rm|ls> [<user-id>]");
      return;
    }
    const access = loadAccess(pre.accessJson);
    access.allowFrom = access.allowFrom || [];
    if (action === "ls") {
      log(`  global allowlist (${access.allowFrom.length}):`);
      for (const id of access.allowFrom) log(`    ${id}`);
      return;
    }
    if (!userId) {
      log(`usage: maw discord access <bot> allow ${action} <user-id>`);
      return;
    }
    if (action === "add") {
      if (access.allowFrom.includes(userId)) {
        log(`  ○ ${userId} already in allowlist`);
        return;
      }
      access.allowFrom.push(userId);
      saveAccess(pre.accessJson, access);
      log(`  ✓ added ${userId} to global allowlist`);
    } else { // rm
      const before = access.allowFrom.length;
      access.allowFrom = access.allowFrom.filter((id: string) => id !== userId);
      if (access.allowFrom.length === before) {
        log(`  ○ ${userId} not in allowlist`);
        return;
      }
      saveAccess(pre.accessJson, access);
      log(`  ✓ removed ${userId} from global allowlist`);
    }
  },

  async lockdown(log: (s: string) => void, pre: BotResolved, args: string[]): Promise<void> {
    const { flags } = parseFlags(args);
    const access = loadAccess(pre.accessJson);
    const current = access.dmPolicy;
    const target = flags.off ? "pairing" : "allowlist";
    if (current === target) {
      log(`  ○ dmPolicy already '${target}' — no change`);
      return;
    }
    if (flags.dryRun) {
      log(`  [dry-run] would set dmPolicy: '${current}' → '${target}'`);
      return;
    }
    access.dmPolicy = target;
    saveAccess(pre.accessJson, access);
    log(`  ✓ dmPolicy: '${current}' → '${target}'`);
  },
};
