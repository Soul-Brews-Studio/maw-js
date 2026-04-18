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
import { loadPeers, mutatePeers, type Peer } from "./store";

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

/** Best-effort fetch of <url>/info to resolve node name. Returns null on any failure. */
export async function resolveNode(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(new URL("/info", url), { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = await res.json() as { node?: unknown; name?: unknown };
    const node = (typeof body.node === "string" && body.node)
      || (typeof body.name === "string" && body.name)
      || null;
    return node || null;
  } catch {
    return null;
  }
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
}

export async function cmdAdd(opts: AddOptions): Promise<AddResult> {
  const aliasErr = validateAlias(opts.alias);
  if (aliasErr) throw new Error(aliasErr);
  const urlErr = validateUrl(opts.url);
  if (urlErr) throw new Error(urlErr);

  // Resolve node OUTSIDE the lock — it does network I/O.
  const node = opts.node ?? await resolveNode(opts.url);
  const peer: Peer = {
    url: opts.url,
    node: node || null,
    addedAt: new Date().toISOString(),
    lastSeen: null,
  };
  let existed = false;
  mutatePeers((data) => {
    existed = Boolean(data.peers[opts.alias]);
    data.peers[opts.alias] = peer;
  });
  return { alias: opts.alias, overwrote: existed, peer };
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
  const header = ["alias", "url", "node", "lastSeen"];
  const lines = rows.map(r => [r.alias, r.url, r.node ?? "-", r.lastSeen ?? "-"]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map(l => l[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map(w => "-".repeat(w))), ...lines.map(fmt)].join("\n");
}
