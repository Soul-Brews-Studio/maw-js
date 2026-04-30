/**
 * maw team invite — invite a remote oracle to a local team (#644 Phase 2).
 *
 * Completes the 3-layer consent story (Phase 1: hey, Phase 3: plugin-install).
 * Adding a remote oracle to a team is a privileged action — the invitee will
 * receive team messages, tasks, and eventually share knowledge at shutdown
 * via --merge. Phase 2 gates this with the same PIN-consent primitive.
 *
 * Default OFF. Opt in via MAW_CONSENT=1 (same convention as Phase 1 + 3).
 *
 * When consent IS required and not yet trusted, we:
 *   1. Resolve the peer in namedPeers → peerUrl (the "hard ID").
 *   2. requestConsent(action="team-invite") with a summary containing
 *      team + lead + invitee + scope so the approver has full context.
 *   3. Print the PIN + "on <peer>: maw consent approve ..." + exit 2.
 *
 * Once the peer has approved (or an existing trust entry matches), we add
 * the peer to the team manifest under `invitees` and return. The caller
 * re-runs `maw team invite` after OOB PIN relay.
 *
 * Trust-key scope note: trust is bound to (myNode, peerNode, "team-invite").
 * A `hey` or `plugin-install` trust entry does NOT allow a team invite — the
 * scopes are intentionally distinct (see gate-plugin-install.ts §2).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../../config";
import { isTrusted, requestConsent } from "../../../core/consent";
import { resolvePsi } from "./team-helpers";

export interface TeamInviteOptions {
  /** Scope string surfaced in the consent summary (default: "member"). */
  scope?: string;
  /** Team lead name surfaced in the consent summary. Defaults to config.node. */
  lead?: string;
  /** Test injection — override peer lookup. Defaults to config.namedPeers. */
  peerLookup?: (peerName: string) => NamedPeer | null;
  /** Test injection — override local node. Defaults to config.node. */
  myNode?: string;
}

export interface TeamInviteDecision {
  ok: boolean;
  exitCode?: number;
  /** Message to print to stderr when ok=false. */
  message?: string;
}

const SCOPE_DEFAULT = "member";

export interface NamedPeer {
  name: string;
  url: string;
  node?: string;
}

function defaultPeerLookup(peerName: string): NamedPeer | null {
  const cfg = loadConfig() as { namedPeers?: NamedPeer[] };
  const named = cfg.namedPeers ?? [];
  return named.find(p => p.name === peerName) ?? null;
}

function manifestPath(teamName: string): string {
  return join(resolvePsi(), "memory", "mailbox", "teams", teamName, "manifest.json");
}

/**
 * Record the invitee in the team manifest. Idempotent — repeat invites
 * are no-ops so post-consent re-runs don't duplicate entries.
 *
 * No `existsSync` precheck: catch ENOENT on the read instead. CodeQL's
 * `js/file-system-race` flags check-then-use patterns regardless of path
 * ownership, and inline `// lgtm` markers don't suppress alerts under the
 * current GHAS scanner (see .github/codeql/codeql-config.yml). The
 * read-then-write pattern matches team-lifecycle.ts (#393) which ships
 * without an alert.
 */
export function recordInvitee(teamName: string, peer: NamedPeer, scope: string): void {
  const path = manifestPath(teamName);
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(`team '${teamName}' not found — run: maw team create ${teamName}`);
    }
    throw e;
  }
  manifest.invitees = Array.isArray(manifest.invitees) ? manifest.invitees : [];
  const existing = manifest.invitees.findIndex((i: any) => i?.name === peer.name);
  const entry = {
    name: peer.name,
    url: peer.url,
    node: peer.node,
    scope,
    invitedAt: new Date().toISOString(),
  };
  if (existing >= 0) {
    manifest.invitees[existing] = entry;
  } else {
    manifest.invitees.push(entry);
  }
  // lgtm[js/file-system-race] — PRIVATE-PATH: manifest under ψ/memory/mailbox/teams/<team>/, see docs/security/file-system-race-stance.md
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

/**
 * Pure decision function — easier to unit-test than the CLI wrapper.
 * Returns ok=true iff the invite was recorded; ok=false carries the
 * stderr message + exit code the CLI should print.
 */
export async function runTeamInvite(
  teamName: string,
  peerName: string,
  opts: TeamInviteOptions = {},
): Promise<TeamInviteDecision> {
  if (!existsSync(manifestPath(teamName))) {
    return {
      ok: false,
      exitCode: 1,
      message: `\x1b[31m✗\x1b[0m team '${teamName}' not found — run: maw team create ${teamName}`,
    };
  }

  const lookup = opts.peerLookup ?? defaultPeerLookup;
  const peer = lookup(peerName);
  if (!peer) {
    return {
      ok: false,
      exitCode: 1,
      message:
        `\x1b[31m✗\x1b[0m unknown peer '${peerName}' — not in namedPeers.\n` +
        `  hint: add ${peerName} to maw.config.json namedPeers`,
    };
  }

  const scope = opts.scope || SCOPE_DEFAULT;

  // Default OFF — opt in via MAW_CONSENT=1. When off, skip the PIN round-trip
  // entirely and record the invite directly (legacy path).
  if (process.env.MAW_CONSENT !== "1") {
    recordInvitee(teamName, peer, scope);
    return { ok: true };
  }

  const myNode = opts.myNode ?? (loadConfig().node ?? "local");
  const lead = opts.lead || myNode;

  // Trust key falls back to peerName when peer didn't advertise a node.
  // Same convention as gate-plugin-install.ts — keeps trust decisions
  // expressible even for legacy peers.
  const peerIdForTrust = peer.node || peer.name;
  if (isTrusted(myNode, peerIdForTrust, "team-invite")) {
    recordInvitee(teamName, peer, scope);
    return { ok: true };
  }

  const summary =
    `team-invite: team='${teamName}' lead='${lead}' ` +
    `invitee='${peer.name}'${peer.node ? ` (${peer.node})` : ""} ` +
    `url='${peer.url}' scope='${scope}'`;

  const r = await requestConsent({
    from: myNode,
    to: peerIdForTrust,
    action: "team-invite",
    summary,
    peerUrl: peer.url,
  });

  if (!r.ok) {
    return {
      ok: false,
      exitCode: 1,
      message: [
        `\x1b[31m✗ consent request failed\x1b[0m: ${r.error}`,
        r.requestId ? `  request id (local mirror): ${r.requestId}` : "",
        `  hint: peer may be down, or /api/consent/request not yet deployed`,
      ].filter(Boolean).join("\n"),
    };
  }

  return {
    ok: false,
    exitCode: 2,
    message: [
      `\x1b[33m⏸  consent required\x1b[0m → team-invite`,
      `   team:   ${teamName}  (lead: ${lead})`,
      `   peer:   ${peer.name}${peer.node ? ` (${peer.node})` : ""}  [${peer.url}]`,
      `   scope:  ${scope}`,
      `   request id: ${r.requestId}`,
      `   PIN (relay OOB to ${peerIdForTrust} operator): \x1b[1m${r.pin}\x1b[0m`,
      `   expires: ${r.expiresAt}`,
      ``,
      `   on ${peerIdForTrust}: \x1b[36mmaw consent approve ${r.requestId} ${r.pin}\x1b[0m`,
      `   then re-run: \x1b[36mmaw team invite ${teamName} ${peer.name}\x1b[0m`,
    ].join("\n"),
  };
}

/** CLI entry — prints outcome, returns void. Throws only on programmer error. */
export async function cmdTeamInvite(
  teamName: string,
  peerName: string,
  opts: TeamInviteOptions = {},
): Promise<void> {
  const decision = await runTeamInvite(teamName, peerName, opts);
  if (decision.ok) {
    console.log(`\x1b[32m✓\x1b[0m invited '${peerName}' to team '${teamName}' (scope: ${opts.scope || SCOPE_DEFAULT})`);
    return;
  }
  if (decision.message) console.error(decision.message);
  process.exit(decision.exitCode ?? 1);
}
