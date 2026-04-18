/**
 * registry-resolve: source form parsing + entry lookup.
 */

import { describe, expect, it } from "bun:test";
import {
  githubTarballUrl,
  npmTarballUrl,
  parseGithubRef,
  parseNpmRef,
  resolvePluginSource,
} from "../src/commands/plugins/plugin/registry-resolve";
import type { RegistryManifest } from "../src/commands/plugins/plugin/registry-fetch";

function manifestWith(source: string): RegistryManifest {
  return {
    schemaVersion: 1,
    updated: "2026-04-18T00:00:00Z",
    plugins: {
      foo: {
        version: "1.2.3",
        source,
        sha256: "sha256:" + "a".repeat(64),
        summary: "foo",
        author: "maw",
        license: "MIT",
        addedAt: "2026-04-18T00:00:00Z",
      },
    },
  };
}

describe("parseNpmRef", () => {
  it("parses scoped package", () => {
    expect(parseNpmRef("npm:@maw/foo")).toEqual({ pkg: "@maw/foo", basename: "foo" });
  });
  it("parses unscoped package", () => {
    expect(parseNpmRef("npm:foo")).toEqual({ pkg: "foo", basename: "foo" });
  });
  it("returns null for non-npm", () => {
    expect(parseNpmRef("github:a/b#v1")).toBeNull();
    expect(parseNpmRef("npm:")).toBeNull();
  });
});

describe("parseGithubRef", () => {
  it("parses github:OWNER/REPO#REF", () => {
    expect(parseGithubRef("github:soulbrews/maw-foo#v1.0.0"))
      .toEqual({ owner: "soulbrews", repo: "maw-foo", ref: "v1.0.0" });
  });
  it("returns null when ref is missing", () => {
    expect(parseGithubRef("github:a/b")).toBeNull();
  });
  it("returns null for non-github", () => {
    expect(parseGithubRef("npm:foo")).toBeNull();
  });
});

describe("url builders", () => {
  it("npmTarballUrl composes scoped path", () => {
    expect(npmTarballUrl({ pkg: "@maw/foo", basename: "foo" }, "1.2.3"))
      .toBe("https://registry.npmjs.org/@maw/foo/-/foo-1.2.3.tgz");
  });
  it("githubTarballUrl points at tag archive", () => {
    expect(githubTarballUrl({ owner: "a", repo: "b", ref: "v1" }))
      .toBe("https://github.com/a/b/archive/refs/tags/v1.tar.gz");
  });
});

describe("resolvePluginSource", () => {
  it("returns null for missing entry", () => {
    expect(resolvePluginSource("nope", manifestWith("https://x/y.tgz"))).toBeNull();
  });

  it("resolves npm:@scope/name", () => {
    const r = resolvePluginSource("foo", manifestWith("npm:@maw/foo"))!;
    expect(r.kind).toBe("npm");
    expect(r.source).toBe("https://registry.npmjs.org/@maw/foo/-/foo-1.2.3.tgz");
    expect(r.version).toBe("1.2.3");
    expect(r.sha256).toBe("sha256:" + "a".repeat(64));
  });

  it("resolves github:OWNER/REPO#REF", () => {
    const r = resolvePluginSource("foo", manifestWith("github:soulbrews/maw-foo#v2"))!;
    expect(r.kind).toBe("github");
    expect(r.source).toBe("https://github.com/soulbrews/maw-foo/archive/refs/tags/v2.tar.gz");
  });

  it("passes through https://.../.tgz", () => {
    const url = "https://cdn.example.com/foo-1.2.3.tgz";
    const r = resolvePluginSource("foo", manifestWith(url))!;
    expect(r.kind).toBe("https");
    expect(r.source).toBe(url);
  });

  it("passes through https://.../.tar.gz", () => {
    const url = "https://cdn.example.com/foo.tar.gz";
    const r = resolvePluginSource("foo", manifestWith(url))!;
    expect(r.kind).toBe("https");
    expect(r.source).toBe(url);
  });

  it("throws on unrecognized source form", () => {
    expect(() => resolvePluginSource("foo", manifestWith("git+ssh://weird")))
      .toThrow(/unrecognized source/);
  });
});
