/**
 * `maw discord <guilds|channels|inventory|members>` — Discord-state visibility.
 *
 * Complements access.ts (config side) with the REST/Discord side:
 *   - guilds:    which servers is this bot in?
 *   - channels:  what channels exist per guild?
 *   - members:   who can chat in a channel (allowFrom + optional REST member list)?
 *   - inventory: full report — guilds × channels × access cross-reference
 *
 * All read-only. No JSON mutation. Heavy callers should use --json to pipe.
 */
import { listPassTokens, decryptToken, findHybridDiscord, findLegacyStateDir } from "./lib";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

interface BotPre {
  bot: string;
  stateDir: string;
  tokenName: string;
  token: string;
  accessJson: string;
  channelMap: string;
}

async function resolveBot(log: (s: string) => void, bot: string): Promise<BotPre | null> {
  const hybrid = await findHybridDiscord(bot);
  const legacy = findLegacyStateDir(bot);
  const stateDir = hybrid || legacy;
  if (!stateDir) {
    log(`✗ no state-dir for '${bot}'`);
    return null;
  }
  const tokens = listPassTokens();
  const tok = tokens.find(t => t.bot === bot);
  if (!tok) {
    log(`✗ no pass entry for '${bot}'`);
    return null;
  }
  const token = await decryptToken(tok.name);
  if (!token) {
    log(`✗ failed to decrypt pass entry for '${bot}'`);
    return null;
  }
  return {
    bot,
    stateDir,
    tokenName: tok.name,
    token,
    accessJson: join(stateDir, "access.json"),
    channelMap: join(stateDir, "channel-map.json"),
  };
}

interface Guild {
  id: string;
  name: string;
}

interface Channel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  guild_id?: string;
}

async function fetchGuilds(token: string): Promise<Guild[]> {
  const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`guilds REST ${res.status}`);
  return await res.json() as Guild[];
}

// Per-process user-name cache so repeated id→name lookups don't refetch
const _userCache: Map<string, string> = new Map();

async function resolveUserName(token: string, userId: string): Promise<string> {
  if (_userCache.has(userId)) return _userCache.get(userId)!;
  try {
    const res = await fetch(`https://discord.com/api/v10/users/${userId}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.status === 429) {
      const retry = parseFloat(res.headers.get("retry-after") || "1");
      await new Promise(r => setTimeout(r, (retry + 0.2) * 1000));
      return resolveUserName(token, userId);
    }
    if (!res.ok) { _userCache.set(userId, userId); return userId; }
    const u: any = await res.json();
    const name = u.global_name || u.username || userId;
    _userCache.set(userId, name);
    return name;
  } catch {
    _userCache.set(userId, userId);
    return userId;
  }
}

async function resolveUserList(token: string, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    out.push(await resolveUserName(token, id));
    await new Promise(r => setTimeout(r, 80));
  }
  return out;
}

async function fetchChannels(token: string, guildId: string, retries = 2): Promise<Channel[]> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get("retry-after") || "1");
      await new Promise(r => setTimeout(r, (retryAfter + 0.2) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`channels REST ${res.status} for guild ${guildId}`);
    return await res.json() as Channel[];
  }
  throw new Error(`channels REST 429 (exhausted retries) for guild ${guildId}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function channelTypeLabel(t: number): string {
  switch (t) {
    case 0: return "text";
    case 2: return "voice";
    case 4: return "cat";
    case 5: return "news";
    case 10: case 11: case 12: return "thread";
    case 13: return "stage";
    case 15: return "forum";
    case 16: return "media";
    default: return `t${t}`;
  }
}

function loadAccessGroups(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")).groups || {}; } catch { return {}; }
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, any> } {
  const positional: string[] = [];
  const flags: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") flags.json = true;
    else if (a === "--all-guilds") flags.allGuilds = true;
    else if (a === "--with-threads") flags.withThreads = true;
    else if (a === "--guild") flags.guild = args[++i] ?? "";
    else positional.push(a);
  }
  return { positional, flags };
}

export const cmdGuilds = {
  async run(log: (s: string) => void, args: string[]): Promise<void> {
    const [bot, ...rest] = args;
    if (!bot) { log("usage: maw discord guilds <bot> [--json]"); return; }
    const pre = await resolveBot(log, bot);
    if (!pre) return;
    const { flags } = parseFlags(rest);
    const guilds = await fetchGuilds(pre.token);
    if (flags.json) {
      log(JSON.stringify({ bot, guilds }, null, 2));
      return;
    }
    log(`🌐 ${bot} is in ${guilds.length} server(s):`);
    log("");
    log("  id                    name");
    log("  ────────────────────  ────────────────────────────────────");
    for (const g of guilds) {
      log(`  ${g.id}  ${g.name}`);
    }
  },
};

export const cmdChannels = {
  async run(log: (s: string) => void, args: string[]): Promise<void> {
    const [bot, ...rest] = args;
    if (!bot) { log("usage: maw discord channels <bot> [--guild <id>] [--all-guilds] [--json] [--with-threads]"); return; }
    const pre = await resolveBot(log, bot);
    if (!pre) return;
    const { flags } = parseFlags(rest);

    const guilds = await fetchGuilds(pre.token);
    const targets = flags.guild
      ? guilds.filter(g => g.id === flags.guild)
      : (flags.allGuilds ? guilds : guilds.slice(0, 1));

    const out: Array<{ guild: Guild; channels: Channel[] }> = [];
    for (const g of targets) {
      try {
        await sleep(250); // pace requests to stay under Discord per-route limits
        const chs = await fetchChannels(pre.token, g.id);
        const filtered = flags.withThreads ? chs : chs.filter(c => c.type !== 10 && c.type !== 11 && c.type !== 12);
        out.push({ guild: g, channels: filtered });
      } catch (e: any) {
        log(`  ⚠ ${g.id} ${g.name}: ${e.message}`);
      }
    }
    if (flags.json) {
      log(JSON.stringify({ bot, guilds: out }, null, 2));
      return;
    }
    log(`📺 ${bot} channels across ${out.length} guild(s):`);
    log("");
    for (const { guild, channels } of out) {
      log(`  ▼ ${guild.name} (${guild.id})  ·  ${channels.length} channel(s)`);
      const groups: Record<string, Channel[]> = {};
      for (const c of channels) {
        const cat = c.parent_id || "_root";
        if (!groups[cat]) groups[cat] = [];
        groups[cat]!.push(c);
      }
      const cats = channels.filter(c => c.type === 4);
      const catNameById = new Map(cats.map(c => [c.id, c.name]));
      for (const c of channels.filter(c => c.type !== 4).sort((a, b) => a.name.localeCompare(b.name))) {
        const catLabel = c.parent_id ? `[${catNameById.get(c.parent_id) || "?"}]` : "";
        log(`     ${c.id}  ${channelTypeLabel(c.type).padEnd(6)}  #${c.name.padEnd(36)} ${catLabel}`);
      }
      log("");
    }
  },
};

export const cmdMembers = {
  async run(log: (s: string) => void, args: string[]): Promise<void> {
    const [bot, channelArg] = args;
    if (!bot || !channelArg) { log("usage: maw discord members <bot> <channel-name-or-id> [--json]"); return; }
    const pre = await resolveBot(log, bot);
    if (!pre) return;

    // Resolve channel to id
    let channelId = /^\d+$/.test(channelArg) ? channelArg : null;
    if (!channelId) {
      const map = existsSync(pre.channelMap) ? JSON.parse(readFileSync(pre.channelMap, "utf8")) : {};
      channelId = map[channelArg] || null;
    }
    if (!channelId) {
      log(`✗ channel '${channelArg}' not in channel-map. Run 'maw discord access ${bot} map --guild <id> --refresh'`);
      return;
    }
    const groups = loadAccessGroups(pre.accessJson);
    const cfg = groups[channelId];
    if (!cfg) {
      log(`✗ channel ${channelId} not in access.json groups for ${bot}`);
      return;
    }
    const { flags } = parseFlags(args.slice(2));
    const ids: string[] = cfg.allowFrom || [];
    const names = await resolveUserList(pre.token, ids);
    const pairs = ids.map((id, i) => ({ id, name: names[i]! }));
    const result = {
      bot,
      channel: { id: channelId, name: channelArg },
      requireMention: cfg.requireMention,
      allowFrom: pairs,
      effective: ids.length === 0 ? "EVERYONE (no allowlist)" : `${ids.length} user(s)`,
    };
    if (flags.json) { log(JSON.stringify(result, null, 2)); return; }
    log(`👥 ${bot} · #${channelArg} (${channelId})`);
    log(`   requireMention: ${result.requireMention}`);
    if (pairs.length === 0) {
      log(`   allowFrom:      (none)`);
    } else {
      log(`   allowFrom:`);
      for (const p of pairs) log(`     · ${p.name.padEnd(18)} (${p.id})`);
    }
    log(`   effective:      ${result.effective}`);
  },
};

export const cmdInventory = {
  async run(log: (s: string) => void, args: string[]): Promise<void> {
    const [bot, ...rest] = args;
    if (!bot) { log("usage: maw discord inventory <bot> [--json]"); return; }
    const pre = await resolveBot(log, bot);
    if (!pre) return;
    const { flags } = parseFlags(rest);

    const guilds = await fetchGuilds(pre.token);
    const groups = loadAccessGroups(pre.accessJson);

    interface Row {
      guild: Guild;
      channels: Array<{ channel: Channel; enabled: boolean; mention?: boolean; allowFrom?: string[] }>;
    }
    const rows: Row[] = [];
    for (const g of guilds) {
      try {
        await sleep(250); // pace requests to stay under Discord per-route limits
        const chs = await fetchChannels(pre.token, g.id);
        const visible = chs.filter(c => c.type === 0 || c.type === 5 || c.type === 15);
        const annotated = visible.map(c => {
          const cfg = groups[c.id];
          return {
            channel: c,
            enabled: !!cfg,
            mention: cfg?.requireMention,
            allowFrom: cfg?.allowFrom || [],
          };
        });
        rows.push({ guild: g, channels: annotated });
      } catch (e: any) {
        log(`  ⚠ ${g.id} ${g.name}: ${e.message}`);
      }
    }

    if (flags.json) {
      log(JSON.stringify({ bot, inventory: rows }, null, 2));
      return;
    }

    // Pre-resolve all unique user ids referenced in access.json for nicer rendering
    const allIds = new Set<string>();
    for (const r of rows) for (const c of r.channels) (c.allowFrom || []).forEach(id => allIds.add(id));
    const nameById = new Map<string, string>();
    for (const id of allIds) nameById.set(id, await resolveUserName(pre.token, id));

    let totalEnabled = 0;
    let totalChannels = 0;
    log(`📋 ${bot} — full inventory`);
    log("");
    for (const { guild, channels } of rows) {
      const enabled = channels.filter(c => c.enabled).length;
      totalEnabled += enabled;
      totalChannels += channels.length;
      log(`  ▼ ${guild.name}  (${guild.id})  ·  ${enabled}/${channels.length} enabled`);
      for (const c of channels.sort((a, b) => a.channel.name.localeCompare(b.channel.name))) {
        if (c.enabled) {
          const mention = c.mention ? "✓ tag " : "○ all ";
          const allow = c.allowFrom!.length === 0
            ? "EVERYONE"
            : c.allowFrom!.map(id => nameById.get(id) || id).join(", ");
          log(`     ✓ #${c.channel.name.padEnd(36)} ${mention} ${allow}`);
        } else {
          log(`     · #${c.channel.name.padEnd(36)} (in guild, no access)`);
        }
      }
      log("");
    }
    log(`summary: ${guilds.length} server(s) · ${totalChannels} channels visible · ${totalEnabled} enabled · ${nameById.size} unique allow-users resolved`);
  },
};
