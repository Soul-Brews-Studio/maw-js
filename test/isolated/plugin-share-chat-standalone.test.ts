import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");

describe("share-chat standalone boundary (#2752)", () => {
  test("manifest keeps share-chat opt-in, serve-only, and out of default-active", () => {
    expectStandalonePluginBoundary({
      plugin: "share-chat",
      requireSdk: false,
      allowRelative: [
        "../../../core/serve-route-registry",
        "../../../core/serve-ws-registry",
        "../share/impl",
      ],
    });

    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/share-chat/plugin.json"), "utf8"));
    expect(manifest.name).toBe("share-chat");
    expect(manifest.tier).toBe("extra");
    expect(manifest.hooks.serve.handler).toBe("serve");
    expect(manifest.cli).toBeUndefined();
    const defaults = readFileSync(join(root, "src/plugin/default-active.ts"), "utf8");
    expect(defaults).not.toContain('"share-chat"');
  });

  test("source is pure ephemeral chat relay without tmux or write verbs", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/share-chat/index.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("tmux");
    expect(source).not.toContain("sendKeys");
    expect(source).not.toContain("killPane");
    expect(source).not.toContain("resizePane");
    expect(source).toContain('ctx.ws.route("/ws/share/:slug/chat"');
    expect(source).toContain("verifyShare(slug");
    expect(source).toContain("share.chat !== true");
    expect(source).not.toContain("writeFile");
  });
});
