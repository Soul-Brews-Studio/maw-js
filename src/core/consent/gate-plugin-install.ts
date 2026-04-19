/**
 * Consent gate for `maw plugin install <name>@<peer>` (#644 Phase 3).
 *
 * Plugin install is the highest-risk consent action — the artifact becomes
 * executable code under the caller's ambient privilege. Phase 3 gates it
 * behind the same PIN-consent dance as `maw hey` + `maw team invite`:
 *
 *   1. If the peer/action pair is already trusted → allow.
 *   2. Otherwise, generate a PIN, POST to the peer's /api/consent/request,
 *      mirror locally, and surface the PIN via the terminal. The operator
 *      on the PEER side types `maw consent approve <id> <pin>` and then
 *      the caller re-runs `maw plugin install`.
 *
 * This gate DOES NOT gate local-path, tarball, or URL installs — only
 * `<name>@<peer>` (see cmdPluginInstall). Local installs are already the
 * operator's own bytes; URL installs are blocked by plugins.lock pinning.
 *
 * Default OFF. Opt-in via MAW_CONSENT=1 (same convention as Phase 1/2).
 */
import { isTrusted, requestConsent } from "./index";

export interface PluginInstallGateContext {
  /** Caller's node name. Trust keys are `myNode→peerNode:plugin-install`. */
  myNode: string;
  /** Peer nickname (namedPeers[].name) — shown in the summary. */
  peerName: string;
  /** Peer node name from manifest. May be absent on legacy peers. */
  peerNode?: string;
  /** Peer base URL — the "hard ID" + the target for POST /api/consent/request. */
  peerUrl: string;
  /** Plugin name being installed. */
  pluginName: string;
  /** Plugin version the peer advertised. */
  pluginVersion: string;
  /** sha256 the peer advertised. Truncated to first 8 hex chars in the summary. */
  pluginSha256?: string | null;
}

export interface PluginInstallGateDecision {
  allow: boolean;
  exitCode?: number;
  /** Multi-line message for stderr. Set when allow=false. */
  message?: string;
}

/** First 8 hex chars of an sha256:… string (or plain hex), for display only. */
export function shortSha(sha?: string | null): string {
  if (!sha) return "<no sha>";
  const hex = sha.startsWith("sha256:") ? sha.slice("sha256:".length) : sha;
  return hex.slice(0, 8);
}

export async function maybeGatePluginInstall(
  ctx: PluginInstallGateContext,
): Promise<PluginInstallGateDecision> {
  const { myNode, peerName, peerNode, peerUrl, pluginName, pluginVersion, pluginSha256 } = ctx;

  // Trust key requires a stable peer node identifier. Fall back to peerName
  // when the peer didn't advertise its node (legacy) so install isn't silently
  // un-trustable — the trust decision just binds to nickname instead.
  const peerIdForTrust = peerNode || peerName;
  if (isTrusted(myNode, peerIdForTrust, "plugin-install")) {
    return { allow: true };
  }

  const sha8 = shortSha(pluginSha256);
  const summary =
    `plugin-install ${pluginName}@${pluginVersion} from ${peerName}` +
    `${peerNode ? ` (${peerNode})` : ""}` +
    ` sha256:${sha8}…`;

  const r = await requestConsent({
    from: myNode,
    to: peerIdForTrust,
    action: "plugin-install",
    summary,
    peerUrl,
  });

  if (!r.ok) {
    return {
      allow: false,
      exitCode: 1,
      message: [
        `\x1b[31m✗ consent request failed\x1b[0m: ${r.error}`,
        r.requestId ? `  request id (local mirror): ${r.requestId}` : "",
        `  hint: peer may be down, or /api/consent/request not yet deployed`,
      ].filter(Boolean).join("\n"),
    };
  }

  return {
    allow: false,
    exitCode: 2,
    message: [
      `\x1b[33m⏸  consent required\x1b[0m → plugin-install`,
      `   peer:   ${peerName}${peerNode ? ` (${peerNode})` : ""}  [${peerUrl}]`,
      `   plugin: ${pluginName}@${pluginVersion}  sha256:${sha8}…`,
      `   request id: ${r.requestId}`,
      `   PIN (relay OOB to ${peerIdForTrust} operator): \x1b[1m${r.pin}\x1b[0m`,
      `   expires: ${r.expiresAt}`,
      ``,
      `   on ${peerIdForTrust}: \x1b[36mmaw consent approve ${r.requestId} ${r.pin}\x1b[0m`,
      `   then re-run: \x1b[36mmaw plugin install ${pluginName}@${peerName}\x1b[0m`,
    ].join("\n"),
  };
}
