/**
 * `maw discord tokens` — list/check Discord bot tokens in pass without revealing them.
 *
 * Hybrid pattern: tokens live in pass (~/.password-store/discord/*.gpg), config lives
 * in <bot-repo>/.discord/. This subcommand inspects ONLY the pass side.
 *
 * No side effects. Pure functions. Audit-friendly.
 */
import { listPassTokens, decryptToken, pingDiscord } from "./lib";

export const cmdTokens = {
  /**
   * `maw discord tokens ls` — list tokens in pass without decrypting.
   * Shows: name, size, last-modified. No reveals, no network.
   */
  async ls(log: (s: string) => void): Promise<void> {
    const tokens = listPassTokens();
    if (tokens.length === 0) {
      log(`✗ no tokens in pass (~/.password-store/discord/)`);
      log("hint: pass insert discord/<bot>-token");
      return;
    }

    log(`📦 ${tokens.length} token(s) in pass (~/.password-store/discord/)`);
    log("");
    log("  name                                  size    last-modified");
    log("  ──────────────────────────────────────────────────────────────");
    for (const t of tokens) {
      const name = t.name.padEnd(38);
      const size = `${t.sizeBytes}B`.padEnd(7);
      const when = t.mtime.toISOString().slice(0, 10);
      log(`  ${name}${size} ${when}`);
    }
    log("");
    log(`use 'maw discord tokens check' to verify each one decrypts + Discord 200`);
  },

  /**
   * `maw discord tokens check [bot]` — decrypt each token + ping Discord REST.
   * Shows: OK / FAIL with status code + bot username. Token itself is never printed.
   * Optional <bot> arg narrows to one entry.
   */
  async check(log: (s: string) => void, only?: string): Promise<void> {
    const tokens = listPassTokens();
    if (tokens.length === 0) {
      log(`✗ no tokens to check`);
      return;
    }

    const filtered = only
      ? tokens.filter(t => t.name === only || t.name === `${only}-token` || t.bot === only)
      : tokens;

    if (filtered.length === 0) {
      log(`✗ no token matching '${only}' (tried '${only}', '${only}-token', bot=='${only}')`);
      return;
    }

    log(`🔐 checking ${filtered.length} token(s)...`);
    log("");
    log("  name                                  decrypt  discord  bot");
    log("  ──────────────────────────────────────────────────────────────────");

    let okCount = 0;
    let failCount = 0;
    // Sequential intentional — Discord REST allows 50 req/s global, but serial
    // keeps debug output readable + leaves headroom for other clients on the host.
    // Each request times out at 5s (AbortController in pingDiscord).
    for (const t of filtered) {
      const tok = await decryptToken(t.name);
      const name = t.name.padEnd(38);

      if (!tok) {
        log(`  ${name}✗ fail   —        —`);
        failCount++;
        continue;
      }

      const ping = await pingDiscord(tok);
      const decrypt = "✓ OK   ";
      const status = ping.ok ? `✓ ${ping.status}    ` : `✗ ${ping.status || "ERR"}   `;
      const user = ping.username || (ping.ok ? "—" : "—");
      log(`  ${name}${decrypt} ${status} ${user}`);
      if (ping.ok) okCount++; else failCount++;
    }

    log("");
    log(`summary: ${okCount}/${filtered.length} green${failCount > 0 ? `, ${failCount} fail` : ""}`);
  },
};
