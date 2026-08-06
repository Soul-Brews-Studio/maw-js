/**
 * `maw discord status` — fleet inspection from this host's perspective.
 *
 * Surfaces the configuration chain per bot:
 *   pass token  →  legacy state-dir  →  hybrid .discord/  →  tmux session  →  state-dirs.ts registry
 *
 * Union of pass(20) ∪ state-dirs.ts(18) so anomalies are visible:
 *   - token-only (orphan in pass)
 *   - registered-only (broken: registered but no token)
 *   - normal intersection
 *
 * No side effects. Read-only filesystem + optional Discord REST (--check).
 * Flags: --check (ping Discord REST), --redact (hide dates), --json (machine-readable),
 *        <bot> narrows to a single detail card.
 */
import {
  listPassTokens, decryptToken, pingDiscord,
  findLegacyStateDir, findHybridDiscord, findTmuxSession,
  loadStateDirsRegistry, loadAnchors, findOnlineBunForBot, fmtSize,
} from "./lib";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { hostname } from "os";

interface BotRow {
  bot: string;
  inPass: boolean;
  inRegistry: boolean;
  legacyPath: string | null;
  hybridPath: string | null;
  tmuxLine: string | null;
  online: boolean;
  onlineSession: string | null;
  onlineBunPid: number | null;
  anchor: string | null;
  discordOK?: boolean;
  discordStatus?: number;
  discordUsername?: string;
}

type Severity = "ok" | "warn" | "info" | "error";

function classifyBot(row: BotRow): { severity: Severity; reason: string } {
  // error: registered but no token (broken bot)
  if (row.inRegistry && !row.inPass) {
    return { severity: "error", reason: "registered but no token in pass" };
  }
  // error: token in pass but not registered (orphan)
  if (row.inPass && !row.inRegistry) {
    return { severity: "error", reason: "token in pass but not in state-dirs.ts" };
  }
  // error: --check showed Discord REST failure
  if (row.discordOK === false) {
    return { severity: "error", reason: `Discord REST returned ${row.discordStatus}` };
  }
  // error: tmux exists but no Gateway bun (orphan tmux — bind verification failure)
  if (row.tmuxLine && !row.online) {
    return { severity: "error", reason: "tmux session exists but no Gateway bun — orphan (bind incomplete)" };
  }
  // info: hybrid pattern not yet applied (migration TODO)
  if (row.inPass && row.inRegistry && !row.hybridPath && row.online) {
    return { severity: "info", reason: "online but using legacy state-dir — hybrid pattern not applied" };
  }
  // warn: registered, has hybrid/legacy, but not running locally (probably fine, just offline on this host)
  if (row.inRegistry && !row.online) {
    return { severity: "warn", reason: "offline on this host" };
  }
  return { severity: "ok", reason: "" };
}

async function gatherRows(): Promise<BotRow[]> {
  const tokens = listPassTokens();
  const registry = await loadStateDirsRegistry();
  const anchors = await loadAnchors();
  const allBots = new Set<string>([...tokens.map(t => t.bot), ...registry]);

  const rows: BotRow[] = [];
  for (const bot of Array.from(allBots).sort()) {
    const inPass = tokens.some(t => t.bot === bot);
    const inRegistry = registry.has(bot);
    const legacyPath = findLegacyStateDir(bot);
    const hybridPath = await findHybridDiscord(bot);
    const tmuxLine = await findTmuxSession(bot);
    const onlineInfo = await findOnlineBunForBot(bot);
    rows.push({
      bot,
      inPass,
      inRegistry,
      legacyPath,
      hybridPath,
      tmuxLine,
      online: !!onlineInfo,
      onlineSession: onlineInfo?.tmuxSession ?? null,
      onlineBunPid: onlineInfo?.bunPid ?? null,
      anchor: anchors[bot] ?? null,
    });
  }
  return rows;
}

async function addDiscordChecks(rows: BotRow[]): Promise<void> {
  const tokens = listPassTokens();
  // Sequential — Discord REST 50 req/s global, serial keeps output readable + leaves headroom
  for (const row of rows) {
    if (!row.inPass) continue;
    const tokEntry = tokens.find(t => t.bot === row.bot);
    if (!tokEntry) continue;
    const tok = await decryptToken(tokEntry.name);
    if (!tok) {
      row.discordOK = false;
      row.discordStatus = 0;
      continue;
    }
    const ping = await pingDiscord(tok);
    row.discordOK = ping.ok;
    row.discordStatus = ping.status;
    row.discordUsername = ping.username;
  }
}

function sevIcon(s: Severity): string {
  switch (s) {
    case "ok": return "✓";
    case "warn": return "○";
    case "info": return "·";
    case "error": return "✗";
  }
}

interface StatusOpts {
  check: boolean;
  redact: boolean;
  json: boolean;
  filter?: string;
}

function parseOpts(args: string[]): StatusOpts {
  const opts: StatusOpts = {
    check: args.includes("--check"),
    redact: args.includes("--redact"),
    json: args.includes("--json"),
  };
  const positional = args.filter(a => !a.startsWith("--"));
  if (positional[0]) opts.filter = positional[0];
  return opts;
}

export const cmdStatus = {
  async run(log: (s: string) => void, args: string[]): Promise<void> {
    const opts = parseOpts(args);

    let rows = await gatherRows();
    if (opts.filter) {
      rows = rows.filter(r => r.bot === opts.filter || r.bot === `${opts.filter}-oracle`);
      if (rows.length === 0) {
        log(`✗ no bot matching '${opts.filter}' in pass or state-dirs.ts`);
        return;
      }
    }

    if (opts.check) {
      await addDiscordChecks(rows);
    }

    if (opts.json) {
      return this.emitJson(log, rows, opts);
    }

    if (opts.filter && rows.length === 1) {
      return this.emitDetailed(log, rows[0]!, opts);
    }

    return this.emitTable(log, rows, opts);
  },

  emitTable(log: (s: string) => void, rows: BotRow[], opts: StatusOpts): void {
    const host = hostname().split(".")[0];
    log(`🔍 maw discord status @ ${host} — ${rows.length} bot(s) | ${opts.redact ? "REDACTED · " : ""}${opts.check ? "with Discord REST" : "online/where via bun ancestry — use --check for REST"}`);
    log("");
    const head = "  bot                          online  anchor              drift  where (tmux session)              severity";
    log(head);
    log("  " + "─".repeat(head.length - 2));

    const counts: Record<Severity, number> = { ok: 0, warn: 0, info: 0, error: 0 };
    let driftCount = 0;
    for (const row of rows) {
      const cls = classifyBot(row);
      counts[cls.severity]++;
      const bot = row.bot.padEnd(28);
      const online = row.online ? "✓ ON  " : "✗ off ";
      const anchor = (row.anchor || "—").padEnd(18);
      // Drift detection: bot is online HERE but its anchor is elsewhere → ⚠ drift
      const hostNow = host;
      const isHere = row.anchor === hostNow || row.anchor === `nat@${hostNow}` || row.anchor?.endsWith(`@${hostNow}`) || row.anchor?.endsWith(`@${hostNow}.wg`);
      let drift = "  ─  ";
      if (row.online && row.anchor && !isHere) { drift = "⚠ here"; driftCount++; }
      else if (row.online && row.anchor) drift = " ✓ ok ";
      else if (!row.online && row.anchor && isHere) drift = "⚠ down";
      const where = (row.onlineSession || (row.tmuxLine ? "(orphan tmux)" : "—")).padEnd(33);
      const sev = `${sevIcon(cls.severity)} ${cls.severity}`;
      log(`  ${bot}${online}  ${anchor}  ${drift}  ${where} ${sev}`);
    }

    log("");
    log(`summary @ ${host}: ${counts.ok} ok · ${counts.warn} warn · ${counts.info} info · ${counts.error} error`);
    log(`  online: ${rows.filter(r => r.online).length}/${rows.length}  ·  anchors: ${rows.filter(r => r.anchor).length}/${rows.length}  ·  drift: ${driftCount}`);
    log(`  legend: ✓ ON = Gateway bun verified · anchor = canonical host (state-dirs.ts ANCHORS) · drift = bot online but not on anchor host`);
    if (counts.error > 0 || driftCount > 0) {
      log(`run 'maw discord status <bot>' for details on any error/drift row`);
    }
  },

  emitDetailed(log: (s: string) => void, row: BotRow, opts: StatusOpts): void {
    const cls = classifyBot(row);
    const host = hostname().split(".")[0];
    log(`🔍 ${row.bot}  @ ${host}    ${sevIcon(cls.severity)} ${cls.severity}${cls.reason ? ` — ${cls.reason}` : ""}`);
    log("");

    // Online state (real Gateway, bun ancestry-verified)
    if (row.online) {
      log(`  Gateway:           ✓ ONLINE on ${host}`);
      log(`                       bun pid:      ${row.onlineBunPid}`);
      log(`                       tmux session: ${row.onlineSession || "(detached)"}`);
    } else if (row.tmuxLine) {
      log(`  Gateway:           ✗ OFFLINE — tmux session present but no Gateway bun (orphan)`);
      log(`                       orphan tmux:  ${row.tmuxLine}`);
    } else {
      log(`  Gateway:           ✗ OFFLINE on ${host}`);
    }


    // Pass token
    if (row.inPass) {
      const tokens = listPassTokens();
      const t = tokens.find(x => x.bot === row.bot);
      if (t) {
        const when = opts.redact ? "—" : t.mtime.toISOString().slice(0, 10);
        log(`  Pass token:        ✓ discord/${t.name} (${fmtSize(t.sizeBytes)}, ${when})`);
      }
    } else {
      log(`  Pass token:        ✗ missing — no discord/${row.bot}-token in pass`);
    }

    // Legacy state-dir
    if (row.legacyPath) {
      log(`  Legacy state-dir:  ✓ ${row.legacyPath}/`);
      try {
        const entries = readdirSync(row.legacyPath).filter(f => !f.startsWith("."));
        const hidden = readdirSync(row.legacyPath).filter(f => f.startsWith("."));
        for (const e of [...hidden, ...entries]) {
          const sub = join(row.legacyPath, e);
          try {
            const s = statSync(sub);
            const when = opts.redact ? "—" : s.mtime.toISOString().slice(0, 10);
            log(`                       - ${e.padEnd(20)} ${fmtSize(s.size).padStart(6)}  ${when}`);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    } else {
      log(`  Legacy state-dir:  ✗ not found at ~/.claude/channels/${row.bot}/`);
    }

    // Hybrid pattern
    if (row.hybridPath) {
      log(`  Hybrid .discord/:  ✓ ${row.hybridPath}/`);
    } else {
      log(`  Hybrid .discord/:  ✗ not migrated yet (run 'maw discord bind' once shipped)`);
    }

    // Registry
    if (row.inRegistry) {
      log(`  state-dirs.ts:     ✓ registered (discord-oracle dashboard sees it)`);
    } else {
      log(`  state-dirs.ts:     ✗ NOT registered — add to discord-oracle/src/state-dirs.ts`);
    }

    // Discord
    if (opts.check) {
      if (row.discordOK) {
        log(`  Discord identity:  ✓ ${row.discordStatus} — ${row.discordUsername || "—"}`);
      } else if (row.discordStatus !== undefined) {
        log(`  Discord identity:  ✗ ${row.discordStatus || "ERR"}`);
      }
    } else {
      log(`  Discord identity:  (run with --check to verify)`);
    }
  },

  emitJson(log: (s: string) => void, rows: BotRow[], _opts: StatusOpts): void {
    const host = hostname().split(".")[0];
    const out = {
      host,
      bots: rows.map(r => {
        const cls = classifyBot(r);
        return {
          bot: r.bot,
          severity: cls.severity,
          reason: cls.reason,
          online: r.online,
          online_session: r.onlineSession,
          online_bun_pid: r.onlineBunPid,
          path: r.hybridPath || r.legacyPath,
          in_pass: r.inPass,
          in_registry: r.inRegistry,
          legacy_path: r.legacyPath,
          hybrid_path: r.hybridPath,
          tmux_present: !!r.tmuxLine,
          discord_ok: r.discordOK,
          discord_status: r.discordStatus,
          discord_username: r.discordUsername,
        };
      }),
    };
    log(JSON.stringify(out, null, 2));
  },
};
