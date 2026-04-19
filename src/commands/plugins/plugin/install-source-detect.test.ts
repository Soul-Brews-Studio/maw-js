/**
 * install-source-detect — parsePeerSpec + detectMode(peer) unit tests.
 *
 * Exhaustive coverage of the parse rules in docs/plugins/at-peer-install.md §2.
 * URL/path/tarball still win over @peer — those cases must NOT return peer.
 */
import { describe, it, expect } from "bun:test";
import { parsePeerSpec, detectMode } from "./install-source-detect";

describe("parsePeerSpec — positive cases", () => {
  it("accepts simple name@peer", () => {
    expect(parsePeerSpec("ping@mawjs-parent")).toEqual({ name: "ping", peer: "mawjs-parent" });
  });

  it("accepts peer with dots + hyphens + digits", () => {
    expect(parsePeerSpec("ping@node-A.internal.local")).toEqual({
      name: "ping",
      peer: "node-A.internal.local",
    });
  });

  it("accepts plugin name with hyphens + digits", () => {
    expect(parsePeerSpec("oracle-scan-v2@white")).toEqual({
      name: "oracle-scan-v2",
      peer: "white",
    });
  });

  it("accepts peer that looks like a version (parser-permissive, resolver rejects)", () => {
    // Parser accepts; the peer '1.0.0' will not be in namedPeers at resolve time.
    // That's fine — self-inflicted naming, clean error from resolvePeers.
    expect(parsePeerSpec("ping@1.0.0")).toEqual({ name: "ping", peer: "1.0.0" });
  });
});

describe("parsePeerSpec — negative cases (fall through to other modes)", () => {
  it("returns null for http URL", () => {
    expect(parsePeerSpec("http://host/plugin@1.0.0")).toBeNull();
    expect(parsePeerSpec("https://host/plugin@peer")).toBeNull();
  });

  it("returns null for explicit relative paths", () => {
    expect(parsePeerSpec("./ping@peer")).toBeNull();
    expect(parsePeerSpec("../ping@peer")).toBeNull();
  });

  it("returns null for explicit absolute paths", () => {
    expect(parsePeerSpec("/var/plugins/ping@peer")).toBeNull();
  });

  it("returns null for .tgz / .tar.gz", () => {
    expect(parsePeerSpec("ping@peer.tgz")).toBeNull();
    expect(parsePeerSpec("ping-1.0.0.tar.gz")).toBeNull();
  });

  it("returns null when @ is missing", () => {
    expect(parsePeerSpec("ping")).toBeNull();
  });

  it("returns null when two @ signs", () => {
    expect(parsePeerSpec("ping@1.0.0@peer")).toBeNull();
    expect(parsePeerSpec("@foo@bar")).toBeNull();
  });

  it("returns null when peer is empty", () => {
    expect(parsePeerSpec("ping@")).toBeNull();
  });

  it("returns null when name is empty", () => {
    expect(parsePeerSpec("@peer")).toBeNull();
  });

  it("returns null when name has invalid chars (uppercase, underscore)", () => {
    expect(parsePeerSpec("Ping@peer")).toBeNull();
    expect(parsePeerSpec("ping_x@peer")).toBeNull();
  });

  it("returns null when peer has invalid chars (whitespace, /)", () => {
    expect(parsePeerSpec("ping@peer host")).toBeNull();
    expect(parsePeerSpec("ping@peer/path")).toBeNull();
  });
});

describe("detectMode — peer branch", () => {
  it("returns kind:peer for a bare name@peer spec", () => {
    const m = detectMode("ping@mawjs-parent");
    expect(m.kind).toBe("peer");
    if (m.kind === "peer") {
      expect(m.name).toBe("ping");
      expect(m.peer).toBe("mawjs-parent");
      expect(m.src).toBe("ping@mawjs-parent");
    }
  });

  it("still returns url for http://…@…", () => {
    expect(detectMode("http://host/a@b").kind).toBe("url");
  });

  it("still returns tarball for *.tgz", () => {
    expect(detectMode("ping-1.0.0.tgz").kind).toBe("tarball");
  });

  it("still returns dir for ./name@peer (path wins)", () => {
    expect(detectMode("./ping@peer").kind).toBe("dir");
  });

  it("returns dir for an ambiguous single-token that isn't peer-shape", () => {
    // No '@', so falls through to dir — matches existing behaviour.
    expect(detectMode("ping").kind).toBe("dir");
  });
});
