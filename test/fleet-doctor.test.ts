import { describe, test, expect } from "bun:test";
import {
  checkCollisions,
  checkMissingAgents,
  checkOrphanRoutes,
  checkDuplicatePeers,
  checkSelfPeer,
  checkMissingRepos,
  autoFix,
  type DoctorFinding,
} from "../src/commands/fleet-doctor";
import type { MawConfig, PeerConfig } from "../src/config";

/**
 * fleet-doctor is intentionally split into pure check functions so tests
 * don't need to mock curlFetch, listSessions, or the filesystem (except for
 * checkMissingRepos, which uses real existsSync against paths we know can't
 * exist — e.g. /nonexistent/...).
 */

describe("checkCollisions — class of #239 substring regression", () => {
  test("flags peer name hiding inside a longer session name", () => {
    const sessions = ["oracles", "105-whitekeeper", "08-mawjs"];
    const peers = ["white", "mba"];
    const out = checkCollisions(sessions, peers);
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("collision");
    expect(out[0].level).toBe("error");
    expect(out[0].detail).toEqual({ peer: "white", session: "105-whitekeeper" });
  });

  test("exact session match is fine (maw hey white:foo against session 'white')", () => {
    const out = checkCollisions(["white"], ["white"]);
    expect(out).toEqual([]);
  });

  test("NN-<peer> form is fine (strict matchSession handles it)", () => {
    const out = checkCollisions(["105-white"], ["white"]);
    expect(out).toEqual([]);
  });

  test("empty peer name is skipped safely", () => {
    const out = checkCollisions(["105-whitekeeper"], [""]);
    expect(out).toEqual([]);
  });

  test("multiple collisions all reported", () => {
    const out = checkCollisions(["whitekeeper", "mbawebapp"], ["white", "mba"]);
    expect(out.length).toBe(2);
    expect(out.map((f) => f.detail!.peer).sort()).toEqual(["mba", "white"]);
  });

  test("case-insensitive", () => {
    const out = checkCollisions(["WHITEKEEPER"], ["white"]);
    expect(out.length).toBe(1);
  });
});

describe("checkMissingAgents — mawui's catch", () => {
  test("flags oracle present on peer but missing from local agents map", () => {
    const local = { mawjs: "local", homekeeper: "mba" };
    const peer = { white: ["mawjs", "volt-colab-ml", "mother"] };
    const out = checkMissingAgents(local, peer);
    // mawjs already routed (to local), so only volt-colab-ml + mother flagged
    expect(out.map((f) => f.detail!.oracle).sort()).toEqual(["mother", "volt-colab-ml"]);
    expect(out.every((f) => f.check === "missing-agent")).toBe(true);
    expect(out.every((f) => f.fixable)).toBe(true);
  });

  test("empty peer map → empty findings", () => {
    expect(checkMissingAgents({ mawjs: "local" }, {})).toEqual([]);
  });

  test("finding carries peerNode for autoFix to consume", () => {
    const out = checkMissingAgents({}, { white: ["volt-colab-ml"] });
    expect(out[0].detail).toEqual({ oracle: "volt-colab-ml", peerNode: "white" });
  });
});

describe("checkOrphanRoutes — config.agents pointing nowhere", () => {
  test("flags route to unknown node", () => {
    const out = checkOrphanRoutes(
      { homekeeper: "mars" },
      ["white", "mba"],
      "oracle-world",
    );
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("orphan-route");
    expect(out[0].level).toBe("error");
    expect(out[0].detail).toEqual({ oracle: "homekeeper", node: "mars" });
  });

  test("local node is always known", () => {
    const out = checkOrphanRoutes(
      { mawjs: "oracle-world" },
      [],
      "oracle-world",
    );
    expect(out).toEqual([]);
  });

  test("'local' sentinel is always known", () => {
    const out = checkOrphanRoutes({ mawjs: "local" }, [], "oracle-world");
    expect(out).toEqual([]);
  });

  test("routes to known namedPeers are fine", () => {
    const out = checkOrphanRoutes(
      { homekeeper: "mba", pulse: "white" },
      ["mba", "white"],
      "oracle-world",
    );
    expect(out).toEqual([]);
  });
});

describe("checkDuplicatePeers", () => {
  test("flags duplicate peer name", () => {
    const peers: PeerConfig[] = [
      { name: "white", url: "http://a:3456" },
      { name: "white", url: "http://b:3456" },
    ];
    const out = checkDuplicatePeers(peers);
    expect(out.length).toBe(1);
    expect(out[0].detail!.kind).toBe("name");
  });

  test("flags duplicate URL", () => {
    const peers: PeerConfig[] = [
      { name: "white-a", url: "http://shared:3456" },
      { name: "white-b", url: "http://shared:3456" },
    ];
    const out = checkDuplicatePeers(peers);
    expect(out.length).toBe(1);
    expect(out[0].detail!.kind).toBe("url");
  });

  test("unique peers → no findings", () => {
    const peers: PeerConfig[] = [
      { name: "white", url: "http://a:3456" },
      { name: "mba", url: "http://b:3456" },
    ];
    expect(checkDuplicatePeers(peers)).toEqual([]);
  });
});

describe("checkSelfPeer — federation loop prevention", () => {
  test("flags peer whose name matches local node", () => {
    const out = checkSelfPeer(
      [{ name: "oracle-world", url: "http://elsewhere:3456" }],
      "oracle-world",
      3456,
    );
    expect(out.length).toBe(1);
    expect(out[0].detail!.reason).toBe("name");
  });

  test("flags peer URL pointing at localhost:<localPort>", () => {
    const out = checkSelfPeer(
      [{ name: "self", url: "http://localhost:3456" }],
      "oracle-world",
      3456,
    );
    expect(out.length).toBe(1);
    expect(out[0].detail!.reason).toBe("url");
  });

  test("localhost at a different port is fine (dev sidecar)", () => {
    const out = checkSelfPeer(
      [{ name: "sidecar", url: "http://localhost:3457" }],
      "oracle-world",
      3456,
    );
    expect(out).toEqual([]);
  });

  test("remote URL is fine", () => {
    const out = checkSelfPeer(
      [{ name: "white", url: "http://10.20.0.7:3456" }],
      "oracle-world",
      3456,
    );
    expect(out).toEqual([]);
  });

  test("invalid URL swallowed gracefully (caught by namedPeers validator upstream)", () => {
    const out = checkSelfPeer(
      [{ name: "broken", url: "not-a-url" }],
      "oracle-world",
      3456,
    );
    expect(out).toEqual([]);
  });
});

describe("checkMissingRepos — #237 wake cold-start signal", () => {
  test("flags fleet entry whose repo is not in ghq", () => {
    const entries = [
      { session: { name: "08-mawjs", windows: [{ repo: "Soul-Brews-Studio/ghost-repo" }] } },
    ];
    const out = checkMissingRepos(entries, "/definitely/not/a/real/ghq/root");
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("missing-repo");
    expect(out[0].level).toBe("info");
  });

  test("entry with no repo is skipped", () => {
    const entries = [{ session: { name: "05-empty", windows: [{}] } }];
    const out = checkMissingRepos(entries, "/nonexistent");
    expect(out).toEqual([]);
  });
});

describe("autoFix — only safe transforms", () => {
  test("dedupes peers by name, keeping first occurrence", () => {
    const config = {
      node: "oracle-world",
      port: 3456,
      namedPeers: [
        { name: "white", url: "http://a:3456" },
        { name: "white", url: "http://b:3456" },
      ],
      agents: {},
    } as unknown as MawConfig;

    const findings: DoctorFinding[] = [];
    // autoFix dedupes regardless of findings list — but we won't call saveConfig
    // because this test doesn't have a writable config file. Instead we exercise
    // the shape via a shim that captures what autoFix intends.
    // Trick: since saveConfig is called only when `touched`, and we can't stub
    // it here without mock.module polluting other tests, we inspect the applied
    // list as the observable behavior.
    // (writing to real config is covered in the CLI integration path.)
    const applied = safeAutoFix(findings, config);
    expect(applied.some((m) => m.includes("duplicate peer 'white'"))).toBe(true);
  });

  test("removes self-peer by name", () => {
    const config = {
      node: "oracle-world",
      port: 3456,
      namedPeers: [{ name: "oracle-world", url: "http://10.20.0.4:3456" }],
      agents: {},
    } as unknown as MawConfig;
    const applied = safeAutoFix([], config);
    expect(applied.some((m) => m.includes("self-peer 'oracle-world'"))).toBe(true);
  });

  test("removes self-peer by localhost URL at same port", () => {
    const config = {
      node: "oracle-world",
      port: 3456,
      namedPeers: [{ name: "loopback", url: "http://127.0.0.1:3456" }],
      agents: {},
    } as unknown as MawConfig;
    const applied = safeAutoFix([], config);
    expect(applied.some((m) => m.includes("URL points to self"))).toBe(true);
  });

  test("adds missing agents from fixable findings", () => {
    const config = {
      node: "oracle-world",
      port: 3456,
      namedPeers: [{ name: "white", url: "http://10.20.0.7:3456" }],
      agents: {},
    } as unknown as MawConfig;
    const findings: DoctorFinding[] = [
      {
        level: "warn",
        check: "missing-agent",
        message: "",
        fixable: true,
        detail: { oracle: "volt-colab-ml", peerNode: "white" },
      },
    ];
    const applied = safeAutoFix(findings, config);
    expect(applied.some((m) => m.includes("volt-colab-ml") && m.includes("white"))).toBe(true);
  });

  test("no-op when config is clean", () => {
    const config = {
      node: "oracle-world",
      port: 3456,
      namedPeers: [{ name: "white", url: "http://10.20.0.7:3456" }],
      agents: { mawjs: "local" },
    } as unknown as MawConfig;
    const applied = safeAutoFix([], config);
    expect(applied).toEqual([]);
  });
});

/**
 * safeAutoFix — calls autoFix with a no-op save callback so tests don't touch
 * the real config file. Also records the last update so we can assert on it.
 */
function safeAutoFix(findings: DoctorFinding[], config: MawConfig): string[] {
  return autoFix(findings, config, () => {});
}
