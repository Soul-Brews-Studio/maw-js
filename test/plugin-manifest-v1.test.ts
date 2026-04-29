/**
 * Manifest v1 schema tests — target, capabilities, artifact fields.
 * Phase A: fields are optional (back-compat with the 50+ legacy plugins).
 */

import { describe, test, expect, spyOn } from "bun:test";
import { parseManifest, KNOWN_CAPABILITY_NAMESPACES } from "../src/plugin/manifest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "maw-manifest-v1-"));
}

// ---------------------------------------------------------------------------
// New v1 fields
// ---------------------------------------------------------------------------

describe("manifest v1 — new fields", () => {
  test("parses target, capabilities, artifact", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      const m = parseManifest(
        JSON.stringify({
          name: "hello-ping",
          version: "0.1.0",
          entry: "./index.ts",
          sdk: "^1.0.0",
          target: "js",
          capabilities: ["sdk:identity", "peer:send"],
          artifact: { path: "dist/index.js", sha256: "sha256:abc123" },
        }),
        dir,
      );
      expect(m.target).toBe("js");
      expect(m.capabilities).toEqual(["sdk:identity", "peer:send"]);
      expect(m.artifact).toEqual({ path: "dist/index.js", sha256: "sha256:abc123" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("artifact.sha256 may be null (unbuilt plugin)", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      const m = parseManifest(
        JSON.stringify({
          name: "unbuilt",
          version: "0.1.0",
          entry: "./index.ts",
          sdk: "^1.0.0",
          target: "js",
          capabilities: [],
          artifact: { path: "dist/index.js", sha256: null },
        }),
        dir,
      );
      expect(m.artifact?.sha256).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("artifact alone is a valid entry point (no wasm, no entry)", () => {
    const dir = makeTempDir();
    try {
      const m = parseManifest(
        JSON.stringify({
          name: "compiled",
          version: "1.0.0",
          sdk: "^1.0.0",
          target: "js",
          capabilities: [],
          artifact: { path: "dist/index.js", sha256: null },
        }),
        dir,
      );
      expect(m.artifact?.path).toBe("dist/index.js");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("seeded capability namespaces are frozen set", () => {
    // #874 — `tmux` and `shell` joined the namespace list to support community
    // plugins (bg, rename, park, shellenv) that spawn tmux or shell-eval.
    expect([...KNOWN_CAPABILITY_NAMESPACES].sort()).toEqual(
      ["net", "fs", "peer", "sdk", "proc", "ffi", "tmux", "shell"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Back-compat: legacy manifests still validate
// ---------------------------------------------------------------------------

describe("manifest v1 — legacy manifests still parse", () => {
  test("TS plugin with entry but no target/capabilities/artifact", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      const m = parseManifest(
        JSON.stringify({
          name: "health",
          version: "1.0.0",
          entry: "./index.ts",
          sdk: "^1.0.0",
          cli: { command: "health" },
        }),
        dir,
      );
      expect(m.target).toBeUndefined();
      expect(m.capabilities).toBeUndefined();
      expect(m.artifact).toBeUndefined();
      expect(m.entry).toBe("./index.ts");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("#869 — wasm/entry/artifact all optional; build-impl falls back to ./src/index.ts", () => {
    const dir = makeTempDir();
    try {
      const m = parseManifest(
        JSON.stringify({ name: "bare", version: "1.0.0", sdk: "*" }),
        dir,
      );
      expect(m.wasm).toBeUndefined();
      expect(m.entry).toBeUndefined();
      expect(m.artifact).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

describe("manifest v1 — target", () => {
  test("rejects target 'wasm' with Phase C message", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "too-early",
            version: "1.0.0",
            entry: "./index.ts",
            sdk: "*",
            target: "wasm",
          }),
          dir,
        ),
      ).toThrow(/Phase C/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("rejects unknown target string", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "unknown-target",
            version: "1.0.0",
            entry: "./index.ts",
            sdk: "*",
            target: "python",
          }),
          dir,
        ),
      ).toThrow(/unknown target/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("rejects non-string target", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "bad-target-type",
            version: "1.0.0",
            entry: "./index.ts",
            sdk: "*",
            target: 42,
          }),
          dir,
        ),
      ).toThrow(/target/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Capability validation
// ---------------------------------------------------------------------------

describe("manifest v1 — capabilities", () => {
  test("warns (does not fail) on unknown namespace in MVP", () => {
    const dir = makeTempDir();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      const m = parseManifest(
        JSON.stringify({
          name: "weird-caps",
          version: "1.0.0",
          entry: "./index.ts",
          sdk: "*",
          capabilities: ["blockchain:mine"],
        }),
        dir,
      );
      expect(m.capabilities).toEqual(["blockchain:mine"]);
      expect(warn).toHaveBeenCalled();
      const msg = warn.mock.calls[0]?.[0] as string;
      expect(msg).toMatch(/blockchain/);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts all seeded namespaces without warning", () => {
    const dir = makeTempDir();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      parseManifest(
        JSON.stringify({
          name: "all-ns",
          version: "1.0.0",
          entry: "./index.ts",
          sdk: "*",
          capabilities: [
            "net:fetch",
            "fs:read",
            "peer:send",
            "sdk:identity",
            "proc:spawn",
            "ffi:load",
            "tmux",
            "shell",
          ],
        }),
        dir,
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });

  test("rejects non-array capabilities", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "bad-caps",
            version: "1.0.0",
            entry: "./index.ts",
            sdk: "*",
            capabilities: "sdk:identity",
          }),
          dir,
        ),
      ).toThrow(/capabilities/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact validation
// ---------------------------------------------------------------------------

describe("manifest v1 — artifact", () => {
  test("rejects non-object artifact", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "bad-art",
            version: "1.0.0",
            entry: "./index.ts",
            sdk: "*",
            artifact: "dist/index.js",
          }),
          dir,
        ),
      ).toThrow(/artifact.*object/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("rejects artifact without path", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "no-path",
            version: "1.0.0",
            entry: "./index.ts",
            sdk: "*",
            artifact: { sha256: null },
          }),
          dir,
        ),
      ).toThrow(/artifact\.path/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("rejects sha256 of wrong type", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), "export default () => {};");
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "bad-hash",
            version: "1.0.0",
            entry: "./index.ts",
            sdk: "*",
            artifact: { path: "dist/index.js", sha256: 42 },
          }),
          dir,
        ),
      ).toThrow(/sha256/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
