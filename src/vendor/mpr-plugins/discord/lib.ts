/**
 * Shared utilities for the `maw discord` plugin family.
 *
 * All side-effect-free or read-only. Subcommand modules (tokens.ts, status.ts)
 * import from here so we never duplicate decrypt/REST/filesystem helpers.
 */
import { hostExec } from "maw-js/sdk";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const PASS_DIR = join(homedir(), ".password-store", "discord");
export const LEGACY_STATE_DIR_ROOT = join(homedir(), ".claude", "channels");

export interface TokenEntry {
  name: string;     // e.g. "pulse-oracle-token"
  bot: string;      // e.g. "pulse-oracle"  (token name without -token suffix)
  file: string;
  sizeBytes: number;
  mtime: Date;
}

export function listPassTokens(): TokenEntry[] {
  if (!existsSync(PASS_DIR)) return [];
  return readdirSync(PASS_DIR)
    .filter(f => f.endsWith(".gpg"))
    .map(f => {
      const file = join(PASS_DIR, f);
      const stat = statSync(file);
      const name = f.replace(/\.gpg$/, "");
      const bot = name.replace(/-token$/, "");
      return { name, bot, file, sizeBytes: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function decryptToken(passName: string): Promise<string | null> {
  try {
    const out = await hostExec(`pass show discord/${passName} 2>/dev/null`);
    return out.trim() || null;
  } catch {
    return null;
  }
}

export interface DiscordPing {
  ok: boolean;
  status: number;
  username?: string;
}

export async function pingDiscord(token: string, timeoutMs = 5000): Promise<DiscordPing> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: ctrl.signal,
    });
    if (res.ok) {
      const data: any = await res.json();
      return { ok: true, status: res.status, username: data.username };
    }
    return { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a bot/repo name to its on-disk ghq path. Returns the first match
 * (prefers Soul-Brews-Studio over forks if both exist).
 */
export async function findGhqPath(name: string): Promise<string | null> {
  try {
    // grep (not -F) for end-of-line anchor; escape regex metacharacters in name
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const out = await hostExec(`ghq list -p 2>/dev/null | grep "/${escaped}$" || true`);
    const lines = out.split("\n").map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    // Prefer Soul-Brews-Studio paths over forks/duplicates
    const preferred = lines.find(l => l.includes("/Soul-Brews-Studio/"));
    return preferred ?? lines[0];
  } catch {
    return null;
  }
}

/**
 * Legacy state-dir check: `~/.claude/channels/<bot>/` exists?
 */
export function findLegacyStateDir(bot: string): string | null {
  const path = join(LEGACY_STATE_DIR_ROOT, bot);
  return existsSync(path) ? path : null;
}

/**
 * Hybrid pattern check: `<bot-repo>/.discord/` exists?
 */
export async function findHybridDiscord(bot: string): Promise<string | null> {
  const repo = await findGhqPath(bot);
  if (!repo) return null;
  const discoDir = join(repo, ".discord");
  return existsSync(discoDir) ? discoDir : null;
}

/**
 * tmux session lookup — finds any session whose name contains <bot>.
 * Returns the full session line (e.g. "07-pulse-oracle: 1 windows ...") or null.
 */
export async function findTmuxSession(bot: string): Promise<string | null> {
  try {
    const out = await hostExec(`tmux ls 2>/dev/null | grep -F "${bot}" || true`);
    const first = out.split("\n")[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Parse discord-oracle/src/state-dirs.ts to get the set of registered bots.
 * Returns empty set if discord-oracle isn't cloned locally.
 */
export async function loadStateDirsRegistry(): Promise<Set<string>> {
  const repo = await findGhqPath("discord-oracle");
  if (!repo) return new Set();
  const file = join(repo, "src", "state-dirs.ts");
  if (!existsSync(file)) return new Set();
  try {
    const content = readFileSync(file, "utf8");
    // Limit to STATE_DIRS block (avoid matching ANCHORS keys)
    const stateBlock = content.split(/export const ANCHORS/)[0]!;
    const matches = stateBlock.matchAll(/"([a-z][a-z0-9-]+)":/gi);
    return new Set(Array.from(matches, m => m[1]!));
  } catch {
    return new Set();
  }
}

/**
 * Parse the ANCHORS export from discord-oracle/src/state-dirs.ts.
 * Returns bot → canonical-host mapping. Bots not in ANCHORS have no anchor.
 */
export async function loadAnchors(): Promise<Record<string, string>> {
  const repo = await findGhqPath("discord-oracle");
  if (!repo) return {};
  const file = join(repo, "src", "state-dirs.ts");
  if (!existsSync(file)) return {};
  try {
    const content = readFileSync(file, "utf8");
    const block = content.split(/export const ANCHORS[^{]*{/)[1];
    if (!block) return {};
    const body = block.split(/^};/m)[0] || "";
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/"([a-z][a-z0-9-]+)"\s*:\s*"([^"]+)"/gi)) {
      out[m[1]!] = m[2]!;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Pretty-printed file size — bytes only for v0.2 (most files <1KB).
 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}

/**
 * Find a running bun process for the discord plugin whose env DISCORD_STATE_DIR
 * matches the bot's state-dir. Returns the bun pid + the owning tmux session
 * (walked through claude parent + tmux pane lookup), or null if not online.
 *
 * Used by `bind` for the "already online?" pre-flight check and by v0.3 status
 * to replace the brittle name-grep tmux lookup.
 */
export async function findOnlineBunForBot(bot: string): Promise<{
  bunPid: number;
  claudePid?: number;
  tmuxSession?: string;
} | null> {
  try {
    // Find all bun processes running the discord plugin
    const bunList = await hostExec(`pgrep -f 'discord/0.0.4' 2>/dev/null || true`);
    const pids = bunList.split("\n").map(s => s.trim()).filter(s => /^\d+$/.test(s));

    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      // Read env to check DISCORD_STATE_DIR
      const env = await hostExec(`ps Eww -p ${pid} 2>/dev/null || true`);
      const match = env.match(/DISCORD_STATE_DIR=(\S+)/);
      if (!match) continue;
      const stateDir = match[1]!;
      // Must end with /<bot>
      if (!stateDir.endsWith(`/${bot}`) && !stateDir.endsWith(`/${bot}/`)) continue;

      // Walk up to claude parent
      const parentRaw = await hostExec(`ps -o ppid= -p ${pid} 2>/dev/null || true`);
      const claudePid = parseInt(parentRaw.trim(), 10);

      // Find tmux session containing this claude via pane_pid ancestry
      // We need ancestry walk because pane_pid is typically a shell (zsh) that spawned claude
      let tmuxSession: string | undefined;
      try {
        const panes = await hostExec(`tmux list-panes -a -F '#{session_name}|#{pane_pid}' 2>/dev/null || true`);
        // For each pane_pid, check if claudePid is a descendant
        for (const line of panes.split("\n").filter(Boolean)) {
          const [sess, panePidStr] = line.split("|");
          const panePid = parseInt(panePidStr || "0", 10);
          if (!panePid) continue;
          // Walk claudePid's parents to see if any is panePid
          let cursor = claudePid;
          for (let i = 0; i < 6; i++) {
            if (cursor === panePid) {
              tmuxSession = sess;
              break;
            }
            const parent = await hostExec(`ps -o ppid= -p ${cursor} 2>/dev/null || true`);
            const next = parseInt(parent.trim(), 10);
            if (!next || next === cursor || next === 1) break;
            cursor = next;
          }
          if (tmuxSession) break;
        }
      } catch { /* tmux not available */ }

      return { bunPid: pid, claudePid: isFinite(claudePid) ? claudePid : undefined, tmuxSession };
    }
    return null;
  } catch {
    return null;
  }
}
