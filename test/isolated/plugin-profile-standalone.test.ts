import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

type Profile = {
  name: string;
  description?: string;
  plugins?: string[];
  tiers?: string[];
};

let active = "default";
let profiles: Profile[] = [];
const setCalls: string[] = [];

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  getActiveProfile: () => active,
  loadAllProfiles: () => profiles,
  loadProfile: (name: string) => profiles.find((p) => p.name === name) ?? null,
  setActiveProfile: (name: string) => {
    setCalls.push(name);
    active = name;
  },
}));

const { default: profileHandler } = await import("../../src/vendor/mpr-plugins/profile/index.ts?plugin-profile-standalone");

beforeEach(() => {
  active = "default";
  profiles = [
    { name: "default", description: "Base profile", plugins: ["ping"], tiers: ["core"] },
    { name: "lean", description: "Lean profile", plugins: ["peek", "profile"], tiers: ["lab", "core"] },
  ];
  setCalls.length = 0;
});

describe("profile plugin standalone boundary (#2113)", () => {
  test("uses only plugin-local files plus SDK/plugin type boundaries", () => {
    for (const rel of [
      "src/vendor/mpr-plugins/profile/index.ts",
      "src/vendor/mpr-plugins/profile/impl.ts",
    ]) {
      const source = readFileSync(join(root, rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|config)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }

    const impl = readFileSync(join(root, "src/vendor/mpr-plugins/profile/impl.ts"), "utf8");
    expect(impl).toContain('from "maw-js/sdk"');
  });

  test("lists profiles and marks the active one", async () => {
    active = "lean";

    const result = await profileHandler({ source: "cli", args: ["list"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("lean");
    expect(result.output).toContain("2");
    expect(result.output).toContain("*");
  });

  test("shows current profile and profile JSON", async () => {
    const current = await profileHandler({ source: "cli", args: ["current"] } as any);
    expect(current).toEqual({ ok: true, output: "default" });

    const show = await profileHandler({ source: "cli", args: ["show", "lean"] } as any);
    expect(show.ok).toBe(true);
    expect(JSON.parse(show.output as string)).toMatchObject({ name: "lean" });
  });

  test("switches active profile and reports unknown names", async () => {
    const used = await profileHandler({ source: "cli", args: ["use", "lean"] } as any);
    expect(used.ok).toBe(true);
    expect(used.output).toBe('active profile: "lean"');
    expect(setCalls).toEqual(["lean"]);

    const missing = await profileHandler({ source: "cli", args: ["use", "ghost"] } as any);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('profile "ghost" not found');
  });
});
