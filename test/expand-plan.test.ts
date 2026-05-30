import { describe, expect, test } from "bun:test";
import { computeExpandPlan, deriveExpandNode } from "../src/commands/shared/expand-plan";

const peers = [
  { name: "m5", url: "http://m5.wg:3456" },
  { name: "white", url: "http://white.wg:3456" },
];

describe("deriveExpandNode", () => {
  test("derives node from host argument, not local config", () => {
    expect(deriveExpandNode("oracle-world.wg")).toBe("oracle-world");
    expect(deriveExpandNode("http://white.local:3456")).toBe("white");
  });
});

describe("computeExpandPlan", () => {
  test("builds a dry-run-only plan with routing, trust, service, and firewall sections", () => {
    const plan = computeExpandPlan("oracle-world.wg", 3462, "m5", peers, { user: "mawjs", oracle: "mawjs" });

    expect(plan.target).toMatchObject({
      host: "oracle-world.wg",
      port: 3462,
      node: "oracle-world",
      url: "http://oracle-world.wg:3462",
      user: "mawjs",
      oracle: "mawjs",
    });
    expect(plan.target.aliases).toEqual(["oracle-world", "oracle-world-mawjs", "world-mawjs"]);
    expect(plan.newNodeSeedConfig.namedPeers).toEqual(peers);
    expect(plan.reciprocalPeerUpdates.some((u) => u.recipient === "m5" && u.alias === "world-mawjs" && u.kind === "add")).toBe(true);
    expect(plan.peerStoreUpdates[0]).toMatchObject({ kind: "unsafe", command: "maw pair oracle-world" });
    expect(plan.servicePlan.commands).toContain("maw setup auto-wake --dry-run --port 3462");
    expect(plan.servicePlan.commands.join("\n")).not.toContain("ssh ");
    expect(plan.firewallPlan.command).toContain("ufw allow proto tcp from 10.20.0.0/24 to any port 3462");
    expect(plan.firewallPlan.warnings.join("\n")).toContain("cross-host probe will TIMEOUT");
  });

  test("no peers configured keeps seed config empty and warns", () => {
    const plan = computeExpandPlan("newbox.wg", 3459, "m5", []);

    expect(plan.newNodeSeedConfig).toMatchObject({ kind: "noop", namedPeers: [] });
    expect(plan.warnings.join("\n")).toContain("no known peers configured");
    expect(plan.reciprocalPeerUpdates.map((u) => u.recipient)).toEqual(["m5", "m5"]);
  });

  test("target already present is classified as noop", () => {
    const plan = computeExpandPlan("oracle-world.wg", 3462, "m5", [
      ...peers,
      { name: "oracle-world", url: "http://oracle-world.wg:3462" },
    ]);

    const localRoute = plan.reciprocalPeerUpdates.find((u) => u.recipient === "m5" && u.alias === "oracle-world");
    expect(localRoute?.kind).toBe("noop");
    expect(plan.blockingIssues).toEqual([]);
  });

  test("alias collision and same URL with different identity are conflicts", () => {
    const plan = computeExpandPlan("oracle-world.wg", 3462, "m5", [
      ...peers,
      { name: "oracle-world", url: "http://other.wg:3462" },
    ]);

    const route = plan.reciprocalPeerUpdates.find((u) => u.alias === "oracle-world");
    expect(route?.kind).toBe("conflict");
    expect(route?.existingUrl).toBe("http://other.wg:3462");
    expect(plan.blockingIssues.join("\n")).toContain("already routes");
  });

  test("half-up pair stays trust-side and does not become a routing write", () => {
    const plan = computeExpandPlan("alpha.wg", 3461, "m5", peers);

    expect(plan.peerStoreUpdates).toEqual([
      expect.objectContaining({
        kind: "unsafe",
        peer: "alpha",
        reason: expect.stringContaining("trust is separate from routing"),
      }),
    ]);
    expect(plan.reciprocalPeerUpdates.every((u) => u.command.startsWith("maw peers add "))).toBe(true);
  });

  test("unsupported service OS is explicit and blocking for future apply", () => {
    const plan = computeExpandPlan("macbook.local", 3456, "m5", peers, { targetPlatform: "darwin" });

    expect(plan.servicePlan).toMatchObject({ kind: "unsafe", platform: "darwin", manager: "manual", commands: [] });
    expect(plan.blockingIssues.join("\n")).toContain("unsupported");
  });
});
