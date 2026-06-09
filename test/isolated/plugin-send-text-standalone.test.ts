import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const pluginDir = join(root, "src/vendor/mpr-plugins/send-text");
let sentText: Array<{ target: string; text: string }> = [];
let fetchCalls: Array<{ url: string; opts: any }> = [];
let result: any = { type: "local", target: "mawjs:codex-5" };

class MockTmux {
  async sendText(target: string, text: string) { sentText.push({ target, text }); }
}

const sdkMock = {
  loadConfig: () => ({}),
  listSessions: async () => [{ name: "mawjs", windows: [{ name: "codex-5" }] }],
  resolveTarget: () => result,
  resolveOraclePane: async (target: string) => `${target}.pane`,
  Tmux: MockTmux,
  tmux: { sendKeys: async () => undefined },
  curlFetch: async (url: string, opts: any) => {
    fetchCalls.push({ url, opts });
    return { ok: true, data: { ok: true, target: "peer:pane" } };
  },
};
mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/send-text/index.ts?plugin-send-text-standalone");
const { parseSendTextArgs } = await import("../../src/vendor/mpr-plugins/send-text/impl.ts?plugin-send-text-standalone");

function importsOf(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...importsOf(full));
    else if (entry.name.endsWith(".ts")) {
      const source = readFileSync(full, "utf8");
      const re = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source))) out.push(match[1] ?? match[2]);
    }
  }
  return out;
}

beforeEach(() => {
  sentText = [];
  fetchCalls = [];
  result = { type: "local", target: "mawjs:codex-5" };
});

describe("send-text plugin standalone boundary", () => {
  test("uses SDK or local/platform imports only", () => {
    const imports = importsOf(pluginDir);
    expect(command).toMatchObject({ name: "send-text" });
    expect(imports).toContain("maw-js/sdk");
    expect(imports.filter((spec) =>
      spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/plugin") || spec.startsWith("maw-js/config"),
    )).toEqual([]);
  });

  test("parses target plus text and rejects missing text", () => {
    expect(parseSendTextArgs(["pane", "/awaken"])).toEqual({ target: "pane", text: "/awaken" });
    let thrown: unknown;
    try {
      parseSendTextArgs(["pane"]);
    } catch (err) {
      thrown = err;
    }
    expect(realSdk.isUserError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("text is required");
  });

  test("local CLI invocation sends text plus Enter through Tmux.sendText", async () => {
    const r = await handler({ source: "cli", args: ["codex-5", "hello"] } as any);
    expect(r.ok).toBe(true);
    expect(sentText).toEqual([{ target: "mawjs:codex-5.pane", text: "hello" }]);
    expect(r.output).toContain("sent");
  });

  test("peer target posts pane-keys with Enter", async () => {
    result = { type: "peer", node: "remote", peerUrl: "http://remote", target: "sess:win" };
    const r = await handler({ source: "api", args: { target: "remote", text: "hi" } } as any);
    expect(r.ok).toBe(true);
    expect(JSON.parse(fetchCalls[0].opts.body)).toEqual({ target: "sess:win", text: "hi", enter: true });
  });
});
