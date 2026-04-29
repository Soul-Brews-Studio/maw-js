/**
 * install-source-detect — parsePeerSpec + detectMode(peer) unit tests.
 *
 * Exhaustive coverage of the parse rules in docs/plugins/at-peer-install.md §2.
 * URL/path/tarball still win over @peer — those cases must NOT return peer.
 */
import { describe, it, expect } from "bun:test";
import { parsePeerSpec, parseMonorepoRef, detectMode } from "./install-source-detect";

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

// ─── monorepo: source format (registry#2) ────────────────────────────────────

describe("parseMonorepoRef — positive cases", () => {
  it("parses canonical plugins/<name>@<tag>", () => {
    expect(parseMonorepoRef("monorepo:plugins/shellenv@v0.1.2-shellenv")).toEqual({
      subpath: "plugins/shellenv",
      tag: "v0.1.2-shellenv",
    });
  });

  it("parses tag with multiple dots and hyphens", () => {
    expect(parseMonorepoRef("monorepo:plugins/bg@v1.2.3-rc.4")).toEqual({
      subpath: "plugins/bg",
      tag: "v1.2.3-rc.4",
    });
  });

  it("parses nested subpath", () => {
    expect(parseMonorepoRef("monorepo:plugins/scoped/inner@v0.0.1")).toEqual({
      subpath: "plugins/scoped/inner",
      tag: "v0.0.1",
    });
  });

  it("uses the LAST '@' as the tag separator (tag never contains @)", () => {
    // Defensive — even if a subpath somehow had an '@' (it shouldn't), the
    // last '@' wins because the tag is what's pinned by ref.
    expect(parseMonorepoRef("monorepo:plugins/odd@name@v0.1.0")).toEqual({
      subpath: "plugins/odd@name",
      tag: "v0.1.0",
    });
  });
});

describe("parseMonorepoRef — negative cases", () => {
  it("returns null without monorepo: prefix", () => {
    expect(parseMonorepoRef("plugins/shellenv@v0.1.2")).toBeNull();
    expect(parseMonorepoRef("github:owner/repo#v1")).toBeNull();
  });

  it("returns null when @ is missing", () => {
    expect(parseMonorepoRef("monorepo:plugins/shellenv")).toBeNull();
  });

  it("returns null when subpath is empty", () => {
    expect(parseMonorepoRef("monorepo:@v0.1.2")).toBeNull();
  });

  it("returns null when tag is empty", () => {
    expect(parseMonorepoRef("monorepo:plugins/shellenv@")).toBeNull();
  });

  it("rejects absolute subpath", () => {
    expect(parseMonorepoRef("monorepo:/plugins/shellenv@v0.1.2")).toBeNull();
  });

  it("rejects subpath containing .. segment", () => {
    expect(parseMonorepoRef("monorepo:plugins/../etc@v0.1.2")).toBeNull();
    expect(parseMonorepoRef("monorepo:..@v0.1.2")).toBeNull();
  });
});

describe("detectMode — monorepo branch", () => {
  it("returns kind:monorepo for monorepo:plugins/<name>@<tag>", () => {
    const m = detectMode("monorepo:plugins/shellenv@v0.1.2-shellenv");
    expect(m.kind).toBe("monorepo");
    if (m.kind === "monorepo") {
      expect(m.subpath).toBe("plugins/shellenv");
      expect(m.tag).toBe("v0.1.2-shellenv");
      expect(m.src).toBe("monorepo:plugins/shellenv@v0.1.2-shellenv");
    }
  });

  it("URL still wins over monorepo: (defense — only one parser claims a string)", () => {
    expect(detectMode("https://example.com/monorepo:foo@bar.tgz").kind).toBe("url");
  });

  it("tarball extension still wins over monorepo:", () => {
    // monorepo:foo@bar.tgz — .tgz check runs first, so this routes to tarball.
    expect(detectMode("monorepo:plugins/x@v1.tgz").kind).toBe("tarball");
  });

  it("malformed monorepo: falls through to dir (no @)", () => {
    expect(detectMode("monorepo:plugins/shellenv").kind).toBe("dir");
  });
});
