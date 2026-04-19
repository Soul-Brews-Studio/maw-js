/**
 * Resolve `<name>@<peer>` install specs to a concrete download URL
 * (Task #1, docs/plugins/at-peer-install.md §3).
 *
 * Sits between `cmdPluginInstall` (which detects `kind: "peer"`) and
 * `installFromUrl` (which does the tarball-download + install work).
 * Adds nothing to the trust chain — plugins.lock remains the root — but
 * enriches error messages so the operator sees the peer in the loop.
 */
import { searchPeers, type SearchPeersOpts, type SearchPeersResult } from "./search-peers";

export interface ResolvedPeerSource {
  /** Fully-qualified URL the client should feed to installFromUrl. */
  downloadUrl: string;
  /** sha256 the peer advertised for this plugin (used for the cross-check). */
  peerSha256: string | null | undefined;
  /** Peer friendly name (for success label + error messages). */
  peerName: string;
  /** Peer's node name, if it identified itself (for the success label). */
  peerNode?: string;
  /** The version the peer advertised — surfaced in the success label. */
  version: string;
  /** Peer base URL — used by the #644 Phase 3 consent gate to POST /api/consent/request. */
  peerUrl: string;
}

export interface ResolvePeerInstallOpts {
  /** Injectable searchPeers impl (tests). Defaults to the real one. */
  searchImpl?: typeof searchPeers;
  /** Forwarded to searchImpl — tests use this to avoid real network. */
  searchOpts?: Omit<SearchPeersOpts, "peer">;
}

/**
 * Fan a `<name>@<peer>` spec through `searchPeers`, pick the exact-name
 * match, and return the concrete download URL + peer-advertised hash.
 *
 * Throws (never silently returns null) so `cmdPluginInstall` propagates
 * a clean exit-1 with an actionable message per docs §5.
 */
export async function resolvePeerInstall(
  name: string,
  peer: string,
  opts: ResolvePeerInstallOpts = {},
): Promise<ResolvedPeerSource> {
  const search = opts.searchImpl ?? searchPeers;
  let result: SearchPeersResult;
  try {
    result = await search(name, { ...(opts.searchOpts ?? {}), peer });
  } catch (err: any) {
    // The only throw path in searchPeers is `unknown peer '<peer>'`. Rethrow
    // unchanged — that message is already the one we want to surface.
    throw err;
  }

  // Peer error (offline / unreachable / bad response).
  if (result.errors.length > 0) {
    const e = result.errors[0]!;
    throw new Error(
      `peer '${peer}' ${e.reason}${e.detail ? ` — ${e.detail}` : ""}.\n` +
      `  retry with: maw plugin install ${name}@${peer}`,
    );
  }

  // Exact-name match (searchPeers does substring match; we need exact for install).
  const exact = result.hits.filter(h => h.name === name);
  if (exact.length === 0) {
    const nearby = result.hits.map(h => `${h.name}@${h.version}`).join(", ");
    const available = nearby ? ` — available matches: ${nearby}` : "";
    throw new Error(`no plugin named '${name}' on peer '${peer}'${available}`);
  }
  if (exact.length > 1) {
    const versions = exact.map(h => h.version).join(", ");
    throw new Error(
      `ambiguous install — peer '${peer}' returned multiple versions of '${name}': ${versions}`,
    );
  }
  const hit = exact[0]!;

  // Find the peer's advertised downloadUrl. The searchPeers hit currently
  // doesn't carry it through (its type is lean), so we re-fetch the peer's
  // manifest through searchImpl with a harmless query — no: simpler, synthesize
  // the canonical path. Peer runs the same server code, so
  // `/api/plugin/download/<name>` is stable by construction.
  const downloadUrl = `${hit.peerUrl}/api/plugin/download/${encodeURIComponent(name)}`;

  const resolved: ResolvedPeerSource = {
    downloadUrl,
    peerSha256: hit.sha256,
    peerName: hit.peerName ?? peer,
    version: hit.version,
    peerUrl: hit.peerUrl,
  };
  if (hit.peerNode) resolved.peerNode = hit.peerNode;
  return resolved;
}
