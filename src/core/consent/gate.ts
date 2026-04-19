/**
 * Consent gate for `maw hey` (#644 Phase 1).
 *
 * Called from cmdSend BEFORE delivery when MAW_CONSENT=1. Returns:
 *   - { allow: true } → proceed with normal send
 *   - { allow: false, exitCode, message } → caller prints + exits
 *
 * Gate decisions:
 *   1. Local / self-node target → allow (consent only gates cross-oracle).
 *   2. Already trusted (myNode→peerNode:hey) → allow.
 *   3. Otherwise → request consent, surface PIN to user, deny.
 *
 * The gate is INTENTIONALLY conservative — when resolution is ambiguous
 * or peer is unknown, we allow + let the existing error path surface
 * the actual problem. The gate's job is to add a check, not replace
 * existing diagnostics.
 */
import type { ResolveResult } from "../routing";
import { isTrusted, requestConsent } from "./index";

export interface GateContext {
  myNode: string;
  /** Result of resolveTarget(query, config, sessions) — gate uses it to find peer URL/node. */
  resolved: ResolveResult | null;
  /** Original query (for the summary string shown to approver). */
  query: string;
  /** Message body — truncated for the summary. */
  message: string;
}

export interface GateDecision {
  allow: boolean;
  exitCode?: number;
  /** Multi-line message to print to stderr. Set when allow=false. */
  message?: string;
}

const SUMMARY_MAX = 120;

export async function maybeGateConsent(ctx: GateContext): Promise<GateDecision> {
  const { resolved, myNode, query, message } = ctx;

  // Local or self-node — never gates
  if (!resolved || resolved.type === "error") return { allow: true };
  if (resolved.type === "local" || resolved.type === "self-node") return { allow: true };
  if (resolved.type !== "peer") return { allow: true };

  // Plugin sends already short-circuited above this gate (maw hey plugin:foo).
  // Cross-node peer send: gate it.
  const peerNode = resolved.node;
  if (!peerNode) return { allow: true }; // peer with unknown node — fall through to existing error path

  if (isTrusted(myNode, peerNode, "hey")) return { allow: true };

  const summary = `hey ${query}: "${message.slice(0, SUMMARY_MAX)}${message.length > SUMMARY_MAX ? "…" : ""}"`;
  const r = await requestConsent({
    from: myNode,
    to: peerNode,
    action: "hey",
    summary,
    peerUrl: resolved.peerUrl,
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
      `\x1b[33m⏸  consent required\x1b[0m → ${peerNode} (action: hey)`,
      `   request id: ${r.requestId}`,
      `   PIN (relay OOB to ${peerNode} operator): \x1b[1m${r.pin}\x1b[0m`,
      `   expires: ${r.expiresAt}`,
      ``,
      `   on ${peerNode}: \x1b[36mmaw consent approve ${r.requestId} ${r.pin}\x1b[0m`,
      `   then re-run: \x1b[36mmaw hey ${query} <message>\x1b[0m`,
    ].join("\n"),
  };
}
