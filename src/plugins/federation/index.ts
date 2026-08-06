import type { InvokeContext, InvokeResult } from "maw-js/sdk";

export const command = {
  name: "federation",
  description: "Multi-node federation status, sync, and expansion planning.",
};

function readOption(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();
    const { parsePeerSourceMode } = await import("../../shared/peer-sources");
    const peerSourceRaw = readOption(args, "--peers");
    const peerSource = parsePeerSourceMode(peerSourceRaw, sub === "sync" ? "config" : "both");
    if (!peerSource) {
      return { ok: false, error: "usage: --peers config|scout|both" };
    }

    if (sub === "--help" || sub === "-h" || sub === "help") {
      return {
        ok: false,
        error: "usage: maw federation <status|sync|expand> [host] [--port <port>] [--user <user>] [--oracle <name>] [--verify|--dry-run|--check|--prune|--force|--json|--probe|--peers config|scout|both]",
      };
    }

    if (!sub || sub === "status" || sub === "ls" || sub.startsWith("--")) {
      if (args.includes("--verify")) {
        const { cmdFederationStatusVerify } = await import("../../shared/federation");
        const res = await cmdFederationStatusVerify();
        if (!res.ok) {
          return { ok: false, error: "one or more pairs are non-healthy", output: logs.join("\n") || undefined };
        }
      } else {
        const { cmdFederationStatus } = await import("../../shared/federation");
        await cmdFederationStatus({ peerSourceMode: peerSource });
      }
    } else if (sub === "sync") {
      const { cmdFederationSync } = await import("../../shared/federation-sync");
      await cmdFederationSync({
        dryRun: args.includes("--dry-run"),
        check: args.includes("--check"),
        prune: args.includes("--prune"),
        force: args.includes("--force"),
        json: args.includes("--json"),
        peers: peerSource,
      });
    } else if (sub === "expand") {
      if (args.includes("--apply")) {
        return { ok: false, error: "maw federation expand is read-only in this release; --apply is not supported" };
      }
      const host = args[1];
      if (!host || host.startsWith("--")) {
        return { ok: false, error: "usage: maw federation expand <new-node-host> [--port <port>] [--user <user>] [--oracle <name>] [--probe] [--json]" };
      }
      const portRaw = readOption(args, "--port");
      const port = portRaw ? Number(portRaw) : 3456;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return { ok: false, error: `invalid --port: ${portRaw}` };
      }
      const { loadConfig } = await import("../../../config");
      const { computeExpandPlan, deriveExpandNode } = await import("../../shared/expand-plan");
      const config = loadConfig();
      const seen = new Set<string>();
      const knownPeers = [
        ...(config.namedPeers ?? []),
        ...(config.peers ?? []).map((url) => ({ name: deriveExpandNode(url), url })),
      ].filter((peer) => {
        const key = `${peer.name}::${peer.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const baseOpts = {
        user: readOption(args, "--user"),
        oracle: readOption(args, "--oracle") || config.oracle,
        targetPlatform: "linux" as const,
      };
      const initialPlan = computeExpandPlan(host, port, config.node || "local", knownPeers, baseOpts);
      let probeIdentity;
      if (args.includes("--probe")) {
        const { fetchExpandProbeIdentity } = await import("../../shared/expand-probe");
        probeIdentity = await fetchExpandProbeIdentity(initialPlan.target.url);
      }
      const plan = probeIdentity
        ? computeExpandPlan(host, port, config.node || "local", knownPeers, { ...baseOpts, probeIdentity })
        : initialPlan;
      if (args.includes("--json")) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log();
        console.log(`  🧭 Federation Expand Plan  target: ${plan.target.node} (${plan.target.url})`);
        console.log(`  dry run — no SSH, no config writes, no network mutations`);
        console.log();
        console.log(`  new node seed peers: ${plan.newNodeSeedConfig.namedPeers.length}`);
        console.log(`  reciprocal route updates: ${plan.reciprocalPeerUpdates.filter((u) => u.kind === "add").length} add · ${plan.reciprocalPeerUpdates.filter((u) => u.kind === "noop").length} noop · ${plan.reciprocalPeerUpdates.filter((u) => u.kind === "conflict").length} conflict`);
        console.log(`  trust plan: ${plan.peerStoreUpdates.map((u) => u.command).join(", ")}`);
        console.log(`  service plan: ${plan.servicePlan.kind} (${plan.servicePlan.manager})`);
        for (const cmd of plan.servicePlan.commands) console.log(`    ${cmd}`);
        console.log(`  firewall: ${plan.firewallPlan.command}`);
        if (plan.probePlan) {
          const advertised = plan.probePlan.advertisedNode ? ` node=${plan.probePlan.advertisedNode}` : "";
          const agentCount = plan.probePlan.agents.length;
          console.log(`  probe: ${plan.probePlan.kind} reachable=${plan.probePlan.reachable}${advertised} agents=${agentCount}`);
          for (const warning of plan.probePlan.warnings) console.log(`  ! ${warning}`);
        }
        for (const warning of [...plan.warnings, ...plan.servicePlan.warnings, ...plan.firewallPlan.warnings]) {
          console.log(`  ! ${warning}`);
        }
        if (plan.blockingIssues.length > 0) {
          console.log();
          for (const issue of plan.blockingIssues) console.log(`  BLOCKED: ${issue}`);
        }
        console.log();
      }
    } else {
      return {
        ok: false,
        error: "usage: maw federation <status|sync|expand> [host] [--port <port>] [--user <user>] [--oracle <name>] [--verify|--dry-run|--check|--prune|--force|--json|--probe|--peers config|scout|both]",
      };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
