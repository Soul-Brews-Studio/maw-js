import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  mergeFleetIntoAgents,
  readFleetDir,
  loadFleetAgents,
} from "../src/config/fleet-merge";

// ---- Pure merge logic --------------------------------------------------

describe("mergeFleetIntoAgents (#736 Phase 1.1)", () => {
  test("adds every fleet window to agents as 'local' when map is empty", () => {
    const result = mergeFleetIntoAgents({}, [
      { name: "01-pulse", windows: [{ name: "pulse-oracle" }, { name: "neo-oracle" }] },
      { name: "08-mawjs", windows: [{ name: "mawjs-oracle" }] },
    ]);
    expect(result).toEqual({
      "pulse-oracle": "local",
      "neo-oracle": "local",
      "mawjs-oracle": "local",
    });
  });

  test("never overwrites a hand-tuned agents entry", () => {
    const existing = {
      // user pinned volt-oracle to mba; load must NOT clobber it back to "local"
      "volt-oracle": "mba",
      // fleet says local, but user override stands
      "pulse-oracle": "white",
    };
    const result = mergeFleetIntoAgents(existing, [
      { windows: [{ name: "pulse-oracle" }, { name: "volt-oracle" }, { name: "neo-oracle" }] },
    ]);
    expect(result["volt-oracle"]).toBe("mba");
    expect(result["pulse-oracle"]).toBe("white");
    expect(result["neo-oracle"]).toBe("local");
  });

  test("honors localNode override (e.g. config.node identity)", () => {
    const result = mergeFleetIntoAgents({}, [
      { windows: [{ name: "homekeeper-oracle" }] },
    ], "mba");
    expect(result["homekeeper-oracle"]).toBe("mba");
  });

  test("skips windows with empty/missing name and malformed sessions", () => {
    const result = mergeFleetIntoAgents({}, [
      { windows: [{ name: "" }, { name: "pulse-oracle" }] },
      // @ts-expect-error — exercise the runtime guard for malformed window
      { windows: [{ name: null }] },
      // session with no windows at all
      {},
    ]);
    expect(result).toEqual({ "pulse-oracle": "local" });
  });

  test("no-op when fleet list is empty", () => {
    const result = mergeFleetIntoAgents({ already: "here" }, []);
    expect(result).toEqual({ already: "here" });
  });
});

// ---- Filesystem reader --------------------------------------------------

describe("readFleetDir (#736 Phase 1.1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-fleet-merge-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("returns [] when directory does not exist", () => {
    expect(readFleetDir(join(dir, "does-not-exist"))).toEqual([]);
  });

  test("loads every *.json file, skips *.disabled", () => {
    writeFileSync(join(dir, "01-pulse.json"), JSON.stringify({
      name: "01-pulse",
      windows: [{ name: "pulse-oracle", repo: "Soul-Brews-Studio/pulse-oracle" }],
    }));
    writeFileSync(join(dir, "02-neo.json"), JSON.stringify({
      name: "02-neo",
      windows: [{ name: "neo-oracle" }],
    }));
    // Disabled fleet — ignored by loader
    writeFileSync(join(dir, "03-old.json.disabled"), JSON.stringify({
      name: "03-old",
      windows: [{ name: "old-oracle" }],
    }));

    const sessions = readFleetDir(dir);
    const names = sessions.flatMap(s => (s.windows || []).map(w => w.name));
    expect(names.sort()).toEqual(["neo-oracle", "pulse-oracle"]);
  });

  test("skips a malformed file rather than throwing", () => {
    writeFileSync(join(dir, "01-good.json"), JSON.stringify({
      windows: [{ name: "good-oracle" }],
    }));
    writeFileSync(join(dir, "02-broken.json"), "{ this is not JSON");

    const sessions = readFleetDir(dir);
    const names = sessions.flatMap(s => (s.windows || []).map(w => w.name));
    expect(names).toEqual(["good-oracle"]);
  });
});

// ---- End-to-end loadFleetAgents (reader + merge) -----------------------

describe("loadFleetAgents (#736 Phase 1.1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-fleet-load-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("federation gap fix: fleet-known oracle without prior wake gets routed", () => {
    // Reproduce the #736 scenario: 101-volt-colab-ml.json exists in fleet but
    // config.agents is empty (no manual wake yet). After loadFleetAgents, the
    // map MUST contain volt-colab-ml-oracle so `maw hey volt-colab-ml` can route.
    writeFileSync(join(dir, "101-volt-colab-ml.json"), JSON.stringify({
      name: "101-volt-colab-ml",
      windows: [{ name: "volt-colab-ml-oracle", repo: "Soul-Brews-Studio/volt-colab-ml-oracle" }],
    }));

    const agents = loadFleetAgents({}, "local", dir);
    expect(agents["volt-colab-ml-oracle"]).toBe("local");
  });

  test("missing fleet directory does not throw — returns existing agents unchanged", () => {
    const existing = { someone: "remote-node" };
    const result = loadFleetAgents(existing, "local", join(dir, "nope"));
    expect(result).toEqual(existing);
  });

  test("preserves hand-tuned agents alongside fleet-derived entries", () => {
    writeFileSync(join(dir, "01-pulse.json"), JSON.stringify({
      windows: [{ name: "pulse-oracle" }, { name: "neo-oracle" }],
    }));
    const existing = {
      "pulse-oracle": "white",   // user override — must survive
      "extra-oracle": "mba",      // not in fleet — must survive
    };
    const result = loadFleetAgents(existing, "local", dir);
    expect(result["pulse-oracle"]).toBe("white");
    expect(result["extra-oracle"]).toBe("mba");
    expect(result["neo-oracle"]).toBe("local");
  });

  test("fleet-merged entries use config.node, not literal 'local' (#790)", () => {
    // Regression: load.ts:62 was calling loadFleetAgents(cached.agents || {})
    // without passing cached.node — so on a node named "m5", fleet-merged
    // entries got the literal string "local", which resolveTarget() then
    // failed to recognize as self. This test pins the contract: when the
    // caller passes config.node ("m5"), every fleet-merged window must map
    // to "m5", never to "local".
    writeFileSync(join(dir, "08-mawjs.json"), JSON.stringify({
      name: "08-mawjs",
      windows: [{ name: "mawjs-oracle" }, { name: "neo-oracle" }],
    }));
    const result = loadFleetAgents({}, "m5", dir);
    expect(result["mawjs-oracle"]).toBe("m5");
    expect(result["neo-oracle"]).toBe("m5");
    // And specifically NOT the buggy literal:
    expect(result["mawjs-oracle"]).not.toBe("local");
  });
});
