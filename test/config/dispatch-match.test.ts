/**
 * Tests for resolvePluginMatch from src/cli/dispatch-match.ts.
 * Pure function — two-pass exact-then-prefix matching.
 */
import { describe, it, expect } from "bun:test";
import { resolvePluginMatch } from "../../src/cli/dispatch-match";
import type { LoadedPlugin } from "../../src/plugin/types";

function makePlugin(name: string, command: string, aliases: string[] = []): LoadedPlugin {
  return {
    manifest: {
      name,
      version: "1.0.0",
      cli: { command, aliases },
    },
    kind: "ts",
  } as any;
}

describe("resolvePluginMatch", () => {
  describe("exact match", () => {
    it("matches exact command name", () => {
      const plugins = [makePlugin("oracle", "oracle")];
      const result = resolvePluginMatch(plugins, "oracle");
      expect(result.kind).toBe("match");
      if (result.kind === "match") {
        expect(result.plugin.manifest.name).toBe("oracle");
        expect(result.matchedName).toBe("oracle");
      }
    });

    it("matches via alias", () => {
      const plugins = [makePlugin("oracle", "oracle", ["o"])];
      const result = resolvePluginMatch(plugins, "o");
      expect(result.kind).toBe("match");
    });
  });

  describe("prefix match", () => {
    it("matches prefix with space separator", () => {
      const plugins = [makePlugin("oracle", "oracle")];
      const result = resolvePluginMatch(plugins, "oracle scan");
      expect(result.kind).toBe("match");
      if (result.kind === "match") {
        expect(result.matchedName).toBe("oracle");
      }
    });

    it("does not match partial prefix without space", () => {
      const plugins = [makePlugin("oracle", "oracle")];
      const result = resolvePluginMatch(plugins, "oraclescan");
      expect(result.kind).toBe("none");
    });
  });

  describe("exact beats prefix", () => {
    it("exact match wins when prefix matches also exist", () => {
      const plugins = [
        makePlugin("hey", "hey"),
        makePlugin("he-extended", "he"),
      ];
      const result = resolvePluginMatch(plugins, "hey");
      expect(result.kind).toBe("match");
      if (result.kind === "match") {
        expect(result.plugin.manifest.name).toBe("hey");
      }
    });
  });

  describe("ambiguous matches", () => {
    it("reports ambiguity when multiple exact matches", () => {
      const plugins = [
        makePlugin("plugin-a", "run"),
        makePlugin("plugin-b", "run"),
      ];
      const result = resolvePluginMatch(plugins, "run");
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates).toHaveLength(2);
      }
    });

    it("reports ambiguity when multiple prefix matches (no exact)", () => {
      const plugins = [
        makePlugin("plugin-a", "test"),
        makePlugin("plugin-b", "test"),
      ];
      const result = resolvePluginMatch(plugins, "test foo");
      expect(result.kind).toBe("ambiguous");
    });
  });

  describe("no match", () => {
    it("returns none when no plugins match", () => {
      const plugins = [makePlugin("oracle", "oracle")];
      const result = resolvePluginMatch(plugins, "unknown");
      expect(result.kind).toBe("none");
    });

    it("returns none for empty plugins list", () => {
      expect(resolvePluginMatch([], "anything").kind).toBe("none");
    });

    it("skips plugins without cli config", () => {
      const plugin = { manifest: { name: "nocli", version: "1.0.0" }, kind: "ts" } as any;
      expect(resolvePluginMatch([plugin], "nocli").kind).toBe("none");
    });
  });
});
