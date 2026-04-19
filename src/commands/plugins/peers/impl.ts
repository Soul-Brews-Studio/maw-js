/**
 * maw peers — subcommand implementations (#568).
 *
 * Pure(-ish) functions for CRUD over `~/.maw/peers.json`. No CLI
 * parsing here — the dispatcher in index.ts peels off `args[0]` and
 * hands typed positional + flag data to these functions.
 *
 * Node resolution (when `--node` is not given) is intentionally
 * best-effort: we try `<url>/info`, and on any error (missing endpoint,
 * DNS, timeout) we store `node: null`. An alias without a node is still
 * valid — it just means `alias:<agent>` routing needs the URL-to-node
 * map from another source. That's a follow-up concern.
 */
import { loadPeers, mutatePeers, type Peer, type LastError } from "./store";
import { probePeer } from "./probe";

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateAlias(alias: string): string | null {
  if (!ALIAS_RE.test(alias)) {
    return `invalid alias "${alias}" (must match ^[a-z0-9][a-z0-9_-]{0,31}$)`;
  }
  return null;
}

export function validateUrl(raw: string): string | null {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return `invalid URL "${raw}"`; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `invalid URL "${raw}" (must be http:// or https://)`;
  }
  return null;
}

/**
 * Thin back-compat wrapper returning `string | null`. New callers should
 * use probePeer() directly to get structured errors — but pre-#565 code
 * paths that only want the node name keep working unchanged.
 */
export async function resolveNode(url: string): Promise<string | null> {
  const res = await probePeer(url);
  return res.node;
}

export interface AddOptions {
  alias: string;
  url: string;
  node?: string;
}

export interface AddResult {
  alias: string;
  overwrote: boolean;
  peer: Peer;
  /** Probe error, if the /info handshake failed. Caller prints a loud warning. */
  probeError?: LastError;
}

export async function cmdAdd(opts: AddOptions): Promise<AddResult> {
  const aliasErr = validateAlias(opts.alias);
  if (aliasErr) throw new Error(aliasErr);
  const urlErr = validateUrl(opts.url);
  if (urlErr) throw new Error(urlErr);

  // Probe OUTSIDE the lock — it does network I/O. If --node was supplied
  // we still probe to surface errors, but the user-supplied node wins.
  const probe = await probePeer(opts.url);
  const resolvedNode = opts.node ?? probe.node ?? null;

  const peer: Peer = {
    url: opts.url,
    node: resolvedNode,
    addedAt: new Date().toISOString(),
    lastSeen: probe.error ? null : new Date().toISOString(),
  };
  if (probe.error) peer.lastError = probe.error;
  if (probe.nickname) peer.nickname = probe.nickname;

  let existed = false;
  mutatePeers((data) => {
    existed = Boolean(data.peers[opts.alias]);
    data.peers[opts.alias] = peer;
  });
  return { alias: opts.alias, overwrote: existed, peer, probeError: probe.error };
}

/**
 * Re-run the /info handshake for an existing alias. On success clears
 * lastError and sets lastSeen; on failure records lastError.
 *
 * Throws if the alias does not exist.
 */
export interface ProbeResult {
  alias: string;
  url: string;
  node: string | null;
  ok: boolean;
  error?: LastError;
}

export async function cmdProbe(alias: string): Promise<ProbeResult> {
  const data = loadPeers();
  const existing = data.peers[alias];
  if (!existing) throw new Error(`peer "${alias}" not found`);

  const probe = await probePeer(existing.url);
  const now = new Date().toISOString();

  mutatePeers((d) => {
    const p = d.peers[alias];
    if (!p) return; // removed between load and mutate — race-safe no-op
    if (probe.error) {
      p.lastError = probe.error;
    } else {
      delete p.lastError;
      p.lastSeen = now;
      if (probe.node) p.node = probe.node;
      // Refresh nickname on success: string updates, null clears.
      if (probe.nickname) p.nickname = probe.nickname;
      else if (probe.nickname === null) delete p.nickname;
    }
  });

  return {
    alias,
    url: existing.url,
    node: probe.node ?? existing.node,
    ok: !probe.error,
    error: probe.error,
  };
}

export function cmdList(): Array<{ alias: string } & Peer> {
  const data = loadPeers();
  return Object.entries(data.peers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, p]) => ({ alias, ...p }));
}

export function cmdInfo(alias: string): ({ alias: string } & Peer) | null {
  const data = loadPeers();
  const p = data.peers[alias];
  return p ? { alias, ...p } : null;
}

export function cmdRemove(alias: string): boolean {
  let existed = false;
  mutatePeers((data) => {
    if (data.peers[alias]) {
      existed = true;
      delete data.peers[alias];
    }
  });
  return existed;
}

export function formatList(rows: Array<{ alias: string } & Peer>): string {
  if (!rows.length) return "no peers";
  const header = ["alias", "url", "node", "nickname", "lastSeen"];
  const lines = rows.map(r => [
    r.alias,
    r.url,
    r.node ?? "-",
    r.nickname ?? "-",
    r.lastSeen ?? "-",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map(l => l[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map(w => "-".repeat(w))), ...lines.map(fmt)].join("\n");
}
