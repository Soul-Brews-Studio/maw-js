/**
 * expand-plan.ts — pure planner for `maw federation expand`.
 * No I/O, no network — fully unit-testable.
 */

import type { PeerConfig } from "../../config";

export type ExpandDeltaKind = "noop" | "add" | "update" | "conflict" | "unsafe";

export interface ExpandPlanOptions {
  user?: string;
  oracle?: string;
  targetPlatform?: NodeJS.Platform | "unknown";
  subnet?: string;
}

export interface ExpandTarget {
  host: string;
  port: number;
  node: string;
  url: string;
  user?: string;
  oracle: string;
  aliases: string[];
}

export interface ExpandRouteDelta {
  kind: ExpandDeltaKind;
  recipient: string;
  alias: string;
  url: string;
  command: string;
  reason?: string;
  existingUrl?: string;
}

export interface ExpandPeerStoreDelta {
  kind: ExpandDeltaKind;
  peer: string;
  command: string;
  reason: string;
}

export interface ExpandServicePlan {
  kind: ExpandDeltaKind;
  platform: NodeJS.Platform | "unknown";
  manager: "pm2" | "manual";
  commands: string[];
  warnings: string[];
}

export interface ExpandFirewallPlan {
  kind: ExpandDeltaKind;
  subnet: string;
  command: string;
  warnings: string[];
  verification: string[];
}

export interface ExpandPlan {
  target: ExpandTarget;
  localNode: string;
  newNodeSeedConfig: {
    kind: ExpandDeltaKind;
    namedPeers: PeerConfig[];
    reason?: string;
  };
  reciprocalPeerUpdates: ExpandRouteDelta[];
  peerStoreUpdates: ExpandPeerStoreDelta[];
  servicePlan: ExpandServicePlan;
  firewallPlan: ExpandFirewallPlan;
  warnings: string[];
  blockingIssues: string[];
}

const DEFAULT_ORACLE = "mawjs";
const DEFAULT_SUBNET = "10.20.0.0/24";

function stripProtocol(host: string): string {
  return host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "");
}

function hostWithoutPort(host: string): string {
  const stripped = stripProtocol(host).replace(/^\[/, "").replace(/\]$/, "");
  if (stripped.includes("]:")) return stripped.slice(0, stripped.indexOf("]:"));
  const parts = stripped.split(":");
  return parts.length > 1 ? parts[0] : stripped;
}

export function deriveExpandNode(host: string): string {
  const bare = hostWithoutPort(host).trim().toLowerCase();
  const firstLabel = bare.split(".")[0] || bare;
  return firstLabel.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "new-node";
}

function targetUrl(host: string, port: number): string {
  const protocolMatch = host.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const protocol = protocolMatch?.[1] ?? "http";
  const bareHost = hostWithoutPort(host);
  return `${protocol}://${bareHost}:${port}`;
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function aliasesFor(node: string, oracle: string): string[] {
  const aliases = [node, `${node}-${oracle}`];
  if (node.startsWith("oracle-")) aliases.push(`${node.slice("oracle-".length)}-${oracle}`);
  return uniq(aliases.filter(Boolean));
}

function routeKind(alias: string, url: string, knownPeers: PeerConfig[]): Pick<ExpandRouteDelta, "kind" | "reason" | "existingUrl"> {
  const existing = knownPeers.find((p) => p.name === alias);
  if (!existing) return { kind: "add", reason: "alias is not configured" };
  if (existing.url === url) return { kind: "noop", reason: "alias already routes to target", existingUrl: existing.url };
  return { kind: "conflict", reason: "alias already routes to a different URL", existingUrl: existing.url };
}

/**
 * Compute a deterministic federation-growth plan.
 *
 * This function is intentionally pure: callers provide the target host/port,
 * local node name, and the known peer list. It does not load config, probe the
 * network, write files, or SSH anywhere.
 */
export function computeExpandPlan(
  host: string,
  port: number,
  localNode: string,
  knownPeers: PeerConfig[],
  opts: ExpandPlanOptions = {},
): ExpandPlan {
  const oracle = opts.oracle || DEFAULT_ORACLE;
  const node = deriveExpandNode(host);
  const url = targetUrl(host, port);
  const aliases = aliasesFor(node, oracle);
  const subnet = opts.subnet || DEFAULT_SUBNET;
  const target: ExpandTarget = {
    host: hostWithoutPort(host),
    port,
    node,
    url,
    ...(opts.user ? { user: opts.user } : {}),
    oracle,
    aliases,
  };

  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  if (knownPeers.length === 0) {
    warnings.push("no known peers configured; seed config will be empty except for future local identity");
  }

  const recipients = uniq([localNode, ...knownPeers.map((p) => p.name)]).filter(Boolean);
  const reciprocalPeerUpdates = recipients.flatMap((recipient) => aliases.map((alias) => {
    const classified = routeKind(alias, url, knownPeers);
    if (classified.kind === "conflict") {
      blockingIssues.push(`${alias} already routes to ${classified.existingUrl}; refusing to plan overwrite with ${url}`);
    }
    return {
      ...classified,
      recipient,
      alias,
      url,
      command: `maw peers add ${alias} ${url}`,
    } satisfies ExpandRouteDelta;
  }));

  const peerStoreUpdates: ExpandPeerStoreDelta[] = [
    {
      kind: "unsafe",
      peer: aliases[0] ?? node,
      command: `maw pair ${aliases[0] ?? node}`,
      reason: "trust is separate from routing; require explicit pair/TOFU handshake before writing peers.json",
    },
  ];

  const targetPlatform = opts.targetPlatform || "linux";
  const servicePlan: ExpandServicePlan = targetPlatform === "linux"
    ? {
        kind: "add",
        platform: targetPlatform,
        manager: "pm2",
        commands: [
          `maw setup auto-wake --dry-run --port ${port}`,
          "pm2 save",
        ],
        warnings: [
          "pm2 startup may need a login-shell PATH; verify pm2 is visible in the service environment before reporting success",
          "planner only: commands are emitted for copy/paste and are not executed",
        ],
      }
    : {
        kind: "unsafe",
        platform: targetPlatform,
        manager: "manual",
        commands: [],
        warnings: [
          `service bootstrap is unsupported for target platform ${targetPlatform}; use a manual service plan`,
        ],
      };
  if (servicePlan.kind === "unsafe") blockingIssues.push(servicePlan.warnings[0]);

  const firewallPlan: ExpandFirewallPlan = {
    kind: "add",
    subnet,
    command: `sudo ufw allow proto tcp from ${subnet} to any port ${port} comment "wg1 maw federation ${opts.user || oracle}"`,
    warnings: [
      "cross-host probe will TIMEOUT until this rule is applied",
      "loopback curl is not sufficient; verify from another federation node before reporting listener success",
    ],
    verification: [
      `curl -s http://localhost:${port}/info`,
      `curl -s --max-time 5 http://<wg1-ip>:${port}/info  # run from another node`,
      `maw peers probe ${aliases[0] ?? node}`,
    ],
  };

  return {
    target,
    localNode,
    newNodeSeedConfig: {
      kind: knownPeers.length === 0 ? "noop" : "add",
      namedPeers: knownPeers.map((p) => ({ name: p.name, url: p.url })),
      reason: knownPeers.length === 0 ? "no known peers to seed" : "copy existing routing peers to the new node seed config",
    },
    reciprocalPeerUpdates,
    peerStoreUpdates,
    servicePlan,
    firewallPlan,
    warnings,
    blockingIssues: uniq(blockingIssues),
  };
}
