import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");

async function withMawHome<T>(run: (home: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.MAW_HOME;
  const home = mkdtempSync(join(tmpdir(), "maw-hub-plugin-"));
  process.env.MAW_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("hub transport plugin", () => {
  test("declares transport lifecycle metadata and standalone boundary", () => {
    const loaded = loadManifestFromDir(resolve(root, "src/vendor/mpr-plugins/hub"));

    expect(loaded?.manifest.name).toBe("hub");
    expect(loaded?.manifest.hooks?.transport).toMatchObject({
      script: "./index.ts",
      handler: "transport",
      policy: "best-effort",
    });
    expect(loaded?.manifest.module?.exports).toContain("createHubTransport");

    expectStandalonePluginBoundary({
      plugin: "hub",
      allowRelative: [
        /^\.\.\/\.\.\/\.\.\/config(?:\/types)?$/,
        /^\.\.\/\.\.\/\.\.\/core\/transport\/transport$/,
        /^\.\.\/\.\.\/\.\.\/core\/util\/(?:try-silent|sanitize-log)$/,
        /^\.\.\/\.\.\/\.\.\/core\/xdg$/,
        /^\.\.\/\.\.\/\.\.\/lib\/(?:feed|federation-auth)$/,
      ],
    });
  });

  test("transport hook registers workspace-hub only when workspace config exists", async () => {
    await withMawHome(async (home) => {
      const mod = await import(`../../src/vendor/mpr-plugins/hub/index.ts?standalone-empty=${Date.now()}`);
      const registered: string[] = [];
      expect(await mod.transport({ register: (transport: { name: string }) => registered.push(transport.name), config: { node: "m5" } })).toEqual({ ok: true, registered: [] });

      const workspaces = join(home, "workspaces");
      mkdirSync(workspaces, { recursive: true });
      writeFileSync(join(workspaces, "alpha.json"), JSON.stringify({
        id: "alpha",
        hubUrl: "ws://hub.example.test",
        token: "wst_test",
        sharedAgents: ["mawjs-oracle"],
      }));

      expect(await mod.transport({ register: (transport: { name: string }) => registered.push(transport.name), config: { node: "m5" } })).toEqual({ ok: true, registered: ["workspace-hub"] });
      expect(registered).toEqual(["workspace-hub"]);
    });
  });
});
