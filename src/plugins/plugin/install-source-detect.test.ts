/**
 * install-source-detect — parsePeerSpec + detectMode(peer) unit tests.
 *
 * Exhaustive coverage of the parse rules in docs/plugins/at-peer-install.md §2.
 * URL/path/tarball still win over @peer — those cases must NOT return peer.
 */
import { describe, it, expect } from "bun:test";
import { parsePeerSpec, parseMonorepoRef, parseGithubRef, detectMode } from "./install-source-detect";

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

// ─── github: source format (#939, Vercel-style owner/repo[/sub][@ref]) ──────

describe("parseGithubRef — positive cases", () => {
  it("parses bare owner/repo", () => {
    expect(parseGithubRef("vercel/next.js")).toEqual({
      owner: "vercel",
      repo: "next.js",
    });
  });

  it("parses owner/repo@ref (tag)", () => {
    expect(parseGithubRef("Soul-Brews-Studio/maw-js@v1.2.3")).toEqual({
      owner: "soul-brews-studio",
      repo: "maw-js",
      ref: "v1.2.3",
    });
  });

  it("parses owner/repo/single-segment subpath (no auto-prefix at parse time)", () => {
    // Auto-prefix happens at install-time (resolver); parser keeps it literal.
    expect(parseGithubRef("Soul-Brews-Studio/maw-plugin-registry/bg")).toEqual({
      owner: "soul-brews-studio",
      repo: "maw-plugin-registry",
      subpath: "bg",
    });
  });

  it("parses owner/repo/multi/segment subpath (literal)", () => {
    expect(parseGithubRef("owner/repo/sub/dir/leaf")).toEqual({
      owner: "owner",
      repo: "repo",
      subpath: "sub/dir/leaf",
    });
  });

  it("parses owner/repo/sub@ref together", () => {
    expect(parseGithubRef("Soul-Brews-Studio/maw-plugin-registry/bg@v0.2.1")).toEqual({
      owner: "soul-brews-studio",
      repo: "maw-plugin-registry",
      subpath: "bg",
      ref: "v0.2.1",
    });
  });

  it("lowercases owner + repo (GitHub is case-insensitive)", () => {
    const r = parseGithubRef("Soul-Brews-Studio/MAW-Plugin-Registry");
    expect(r?.owner).toBe("soul-brews-studio");
    expect(r?.repo).toBe("maw-plugin-registry");
  });

  it("preserves case in subpath (paths are case-sensitive)", () => {
    expect(parseGithubRef("Owner/Repo/Plugins/CamelCase")).toEqual({
      owner: "owner",
      repo: "repo",
      subpath: "Plugins/CamelCase",
    });
  });

  it("preserves case in ref (refs are case-sensitive)", () => {
    expect(parseGithubRef("owner/repo@FeatureBranch")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "FeatureBranch",
    });
  });

  it("accepts repo with hyphens, dots, underscores", () => {
    expect(parseGithubRef("owner/some.weird-repo_name")).toEqual({
      owner: "owner",
      repo: "some.weird-repo_name",
    });
  });

  it("accepts a sha-like ref", () => {
    expect(parseGithubRef("owner/repo@abc123def456")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "abc123def456",
    });
  });

  it("rejects double-@ (ambiguous: github repos and refs can't contain '@')", () => {
    // monorepo:'s last-wins rule was for subpaths-with-'@' (defensive). Github
    // repos and refs disallow '@' entirely, so any double-@ is malformed.
    expect(parseGithubRef("owner/repo@maybe@ref")).toBeNull();
  });
});

describe("parseGithubRef — negative cases", () => {
  it("rejects single-token (no slash)", () => {
    expect(parseGithubRef("lodash")).toBeNull();
    expect(parseGithubRef("ping")).toBeNull();
  });

  it("rejects empty / whitespace-only", () => {
    expect(parseGithubRef("")).toBeNull();
    expect(parseGithubRef("   ")).toBeNull();
  });

  it("rejects strings with leading/trailing whitespace", () => {
    expect(parseGithubRef(" owner/repo")).toBeNull();
    expect(parseGithubRef("owner/repo ")).toBeNull();
  });

  it("rejects http / https URLs", () => {
    expect(parseGithubRef("https://github.com/owner/repo")).toBeNull();
    expect(parseGithubRef("http://example.com/x/y")).toBeNull();
  });

  it("rejects relative + absolute paths", () => {
    expect(parseGithubRef("./owner/repo")).toBeNull();
    expect(parseGithubRef("../owner/repo")).toBeNull();
    expect(parseGithubRef("/owner/repo")).toBeNull();
  });

  it("rejects .tgz / .tar.gz", () => {
    expect(parseGithubRef("owner/repo.tgz")).toBeNull();
    expect(parseGithubRef("owner/repo-1.0.0.tar.gz")).toBeNull();
  });

  it("rejects monorepo: prefix", () => {
    expect(parseGithubRef("monorepo:plugins/shellenv@v0.1.2")).toBeNull();
  });

  it("rejects empty owner or repo", () => {
    expect(parseGithubRef("/repo")).toBeNull();
    expect(parseGithubRef("owner/")).toBeNull();
  });

  it("rejects empty subpath segment (trailing slash)", () => {
    expect(parseGithubRef("owner/repo/")).toBeNull();
  });

  it("rejects empty ref (trailing @)", () => {
    expect(parseGithubRef("owner/repo@")).toBeNull();
  });

  it("rejects subpath containing .. segment", () => {
    expect(parseGithubRef("owner/repo/../etc")).toBeNull();
    expect(parseGithubRef("owner/repo/..")).toBeNull();
  });

  it("rejects clone-URL .git suffix", () => {
    expect(parseGithubRef("owner/repo.git")).toBeNull();
  });

  it("rejects whitespace inside subpath / ref", () => {
    expect(parseGithubRef("owner/repo/sub dir")).toBeNull();
    expect(parseGithubRef("owner/repo@bad ref")).toBeNull();
  });

  it("rejects invalid chars in owner", () => {
    expect(parseGithubRef("foo_bar/repo")).toBeNull(); // owner can't contain `_`
    expect(parseGithubRef("-leading/repo")).toBeNull();
    expect(parseGithubRef("trailing-/repo")).toBeNull();
  });
});

describe("detectMode — github branch (#939)", () => {
  it("returns kind:github for owner/repo", () => {
    const m = detectMode("Soul-Brews-Studio/maw-js");
    expect(m.kind).toBe("github");
    if (m.kind === "github") {
      expect(m.owner).toBe("soul-brews-studio");
      expect(m.repo).toBe("maw-js");
      expect(m.subpath).toBeUndefined();
      expect(m.ref).toBeUndefined();
      expect(m.src).toBe("Soul-Brews-Studio/maw-js");
    }
  });

  it("returns kind:github with ref for owner/repo@v1", () => {
    const m = detectMode("vercel/next.js@v14.2.3");
    expect(m.kind).toBe("github");
    if (m.kind === "github") {
      expect(m.owner).toBe("vercel");
      expect(m.repo).toBe("next.js");
      expect(m.ref).toBe("v14.2.3");
    }
  });

  it("returns kind:github with subpath for owner/repo/sub", () => {
    const m = detectMode("owner/repo/bg");
    expect(m.kind).toBe("github");
    if (m.kind === "github") {
      expect(m.subpath).toBe("bg");
      expect(m.ref).toBeUndefined();
    }
  });

  it("returns kind:github with subpath + ref together", () => {
    const m = detectMode("owner/repo/plugins/foo@v0.0.1");
    expect(m.kind).toBe("github");
    if (m.kind === "github") {
      expect(m.subpath).toBe("plugins/foo");
      expect(m.ref).toBe("v0.0.1");
    }
  });

  it("URL still wins over github (https://github.com/owner/repo → url)", () => {
    expect(detectMode("https://github.com/owner/repo").kind).toBe("url");
  });

  it("tarball still wins over github (owner/repo.tgz → tarball)", () => {
    expect(detectMode("owner/repo.tgz").kind).toBe("tarball");
  });

  it("monorepo: still wins over github", () => {
    expect(detectMode("monorepo:plugins/shellenv@v0.1.2").kind).toBe("monorepo");
  });

  it("explicit ./owner/repo still routes to dir", () => {
    expect(detectMode("./owner/repo").kind).toBe("dir");
  });

  it("peer name@host still routes to peer (no slash, no github match)", () => {
    expect(detectMode("ping@mawjs-parent").kind).toBe("peer");
  });

  it("malformed owner/repo/ falls through to dir", () => {
    // Trailing slash → invalid github subpath → falls through.
    expect(detectMode("owner/repo/").kind).toBe("dir");
  });
});
