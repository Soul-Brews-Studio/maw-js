/**
 * Tests for src/commands/plugins/plugin/registry-resolve.ts — pure parsing and URL building.
 */
import { describe, it, expect } from "bun:test";
import {
  parseNpmRef,
  parseGithubRef,
  npmTarballUrl,
  githubTarballUrl,
  resolvePluginSource,
} from "../../src/commands/plugins/plugin/registry-resolve";

describe("parseNpmRef", () => {
  it("parses simple package name", () => {
    expect(parseNpmRef("npm:my-plugin")).toEqual({ pkg: "my-plugin", basename: "my-plugin" });
  });

  it("parses scoped package", () => {
    expect(parseNpmRef("npm:@maw/plugin-foo")).toEqual({ pkg: "@maw/plugin-foo", basename: "plugin-foo" });
  });

  it("returns null for non-npm prefix", () => {
    expect(parseNpmRef("github:owner/repo#v1")).toBeNull();
  });

  it("returns null for empty package", () => {
    expect(parseNpmRef("npm:")).toBeNull();
  });

  it("returns null for bare string", () => {
    expect(parseNpmRef("my-plugin")).toBeNull();
  });

  it("returns null for scoped package without name", () => {
    expect(parseNpmRef("npm:@scope/")).toBeNull();
  });

  it("trims whitespace in package name", () => {
    const result = parseNpmRef("npm: my-plugin ");
    expect(result?.pkg).toBe("my-plugin");
  });
});

describe("parseGithubRef", () => {
  it("parses owner/repo#ref", () => {
    expect(parseGithubRef("github:maw-dev/plugin-core#v1.0.0")).toEqual({
      owner: "maw-dev",
      repo: "plugin-core",
      ref: "v1.0.0",
    });
  });

  it("returns null for missing ref", () => {
    expect(parseGithubRef("github:owner/repo")).toBeNull();
  });

  it("returns null for non-github prefix", () => {
    expect(parseGithubRef("npm:package")).toBeNull();
  });

  it("returns null for missing owner", () => {
    expect(parseGithubRef("github:/repo#v1")).toBeNull();
  });

  it("handles ref with slashes", () => {
    const result = parseGithubRef("github:owner/repo#refs/tags/v2");
    expect(result?.ref).toBe("refs/tags/v2");
  });

  it("returns null for empty string", () => {
    expect(parseGithubRef("")).toBeNull();
  });
});

describe("npmTarballUrl", () => {
  it("builds correct URL for simple package", () => {
    const url = npmTarballUrl({ pkg: "my-plugin", basename: "my-plugin" }, "1.2.3");
    expect(url).toBe("https://registry.npmjs.org/my-plugin/-/my-plugin-1.2.3.tgz");
  });

  it("builds correct URL for scoped package", () => {
    const url = npmTarballUrl({ pkg: "@maw/core", basename: "core" }, "0.1.0");
    expect(url).toBe("https://registry.npmjs.org/@maw/core/-/core-0.1.0.tgz");
  });
});

describe("githubTarballUrl", () => {
  it("builds correct archive URL", () => {
    const url = githubTarballUrl({ owner: "maw-dev", repo: "plugin", ref: "v1.0.0" });
    expect(url).toBe("https://github.com/maw-dev/plugin/archive/refs/tags/v1.0.0.tar.gz");
  });
});

describe("resolvePluginSource", () => {
  const makeRegistry = (plugins: Record<string, any>) => ({ schema: 1, plugins } as any);

  it("resolves npm source", () => {
    const reg = makeRegistry({
      "my-plugin": { source: "npm:my-plugin", version: "1.0.0", sha256: "abc123" },
    });
    const result = resolvePluginSource("my-plugin", reg);
    expect(result?.kind).toBe("npm");
    expect(result?.source).toContain("registry.npmjs.org");
    expect(result?.version).toBe("1.0.0");
    expect(result?.sha256).toBe("abc123");
  });

  it("resolves github source", () => {
    const reg = makeRegistry({
      "gh-plugin": { source: "github:owner/repo#v2.0.0", version: "2.0.0", sha256: null },
    });
    const result = resolvePluginSource("gh-plugin", reg);
    expect(result?.kind).toBe("github");
    expect(result?.source).toContain("github.com/owner/repo");
    expect(result?.sha256).toBeNull();
  });

  it("resolves https tarball source", () => {
    const reg = makeRegistry({
      "url-plugin": { source: "https://example.com/plugin-1.0.tgz", version: "1.0.0", sha256: "def456" },
    });
    const result = resolvePluginSource("url-plugin", reg);
    expect(result?.kind).toBe("https");
    expect(result?.source).toBe("https://example.com/plugin-1.0.tgz");
  });

  it("resolves https tar.gz source", () => {
    const reg = makeRegistry({
      "tgz-plugin": { source: "https://example.com/plugin.tar.gz", version: "1.0.0", sha256: null },
    });
    const result = resolvePluginSource("tgz-plugin", reg);
    expect(result?.kind).toBe("https");
  });

  it("returns null for unknown plugin", () => {
    const reg = makeRegistry({});
    expect(resolvePluginSource("missing", reg)).toBeNull();
  });

  it("throws for unrecognized source format", () => {
    const reg = makeRegistry({
      "bad": { source: "ftp://something", version: "1.0.0", sha256: null },
    });
    expect(() => resolvePluginSource("bad", reg)).toThrow("unrecognized source");
  });

  it("handles https URL with query params", () => {
    const reg = makeRegistry({
      "query-plugin": { source: "https://cdn.example.com/plugin-1.0.tgz?token=abc", version: "1.0.0", sha256: null },
    });
    const result = resolvePluginSource("query-plugin", reg);
    expect(result?.kind).toBe("https");
    expect(result?.source).toContain("?token=abc");
  });
});
