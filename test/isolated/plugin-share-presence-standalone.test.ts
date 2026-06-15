import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");

describe("share-presence standalone boundary (#2773)", () => {
  test("manifest keeps share-presence opt-in, serve-only, and out of default-active", () => {
    expectStandalonePluginBoundary({
      plugin: "share-presence",
      requireSdk: false,
      allowRelative: [
        "../../../core/serve-route-registry",
        "../../../core/serve-ws-registry",
        "../share/impl",
      ],
    });

    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/share-presence/plugin.json"), "utf8"));
    expect(manifest.name).toBe("share-presence");
    expect(manifest.tier).toBe("extra");
    expect(manifest.hooks.serve.handler).toBe("serve");
    expect(manifest.cli).toBeUndefined();
    const defaults = readFileSync(join(root, "src/plugin/default-active.ts"), "utf8");
    expect(defaults).not.toContain('"share-presence"');
  });

  test("source is pure presence bookkeeping without tmux or write verbs", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/share-presence/index.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("tmux");
    expect(source).not.toContain("sendKeys");
    expect(source).not.toContain("killPane");
    expect(source).not.toContain("resizePane");
    expect(source).toContain('ctx.ws.route("/ws/share/:slug/presence"');
    expect(source).toContain("verifyShare(slug");
    expect(source).toContain("share.presence !== true");
  });
});
