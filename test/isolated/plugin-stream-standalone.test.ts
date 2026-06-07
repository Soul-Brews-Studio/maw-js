import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const writes: string[] = [];
const calls: Array<{ method: string; args: unknown[] }> = [];
let sessions = new Set<string>();
let windows: Record<string, Array<{ index: number; name: string }>> = {};

class MockTmux {
  async hasSession(name: string) {
    calls.push({ method: "hasSession", args: [name] });
    return sessions.has(name);
  }
  async listWindows(session: string) {
    calls.push({ method: "listWindows", args: [session] });
    const value = windows[session];
    if (!value) throw new Error(`no such session: ${session}`);
    return value;
  }
  async newSession(name: string, opts?: { window?: string; detached?: boolean }) {
    calls.push({ method: "newSession", args: [name, opts] });
    sessions.add(name);
    windows[name] = [{ index: 0, name: opts?.window ?? "zsh" }];
    return "";
  }
  async killSession(name: string) {
    calls.push({ method: "killSession", args: [name] });
    sessions.delete(name);
    delete windows[name];
  }
  async killWindow(target: string) {
    calls.push({ method: "killWindow", args: [target] });
    const [session, index] = target.split(":");
    windows[session!] = (windows[session!] ?? []).filter((win) => win.index !== Number(index));
  }
  async linkWindow(source: string, target: string, opts?: { detached?: boolean }) {
    calls.push({ method: "linkWindow", args: [source, target, opts] });
    const [session, index] = target.split(":");
    windows[session!] = [...(windows[session!] ?? []), { index: Number(index), name: source.split(":")[1] ?? "linked" }];
  }
  async unlinkWindow(target: string) {
    calls.push({ method: "unlinkWindow", args: [target] });
  }
  async renameWindow(target: string, name: string) {
    calls.push({ method: "renameWindow", args: [target, name] });
    const [session, index] = target.split(":");
    const win = (windows[session!] ?? []).find((item) => item.index === Number(index));
    if (win) win.name = name;
  }
  async setWindowOption(target: string, option: string, value: string) {
    calls.push({ method: "setWindowOption", args: [target, option, value] });
  }
  async run(subcommand: string, ...args: (string | number)[]) {
    calls.push({ method: "run", args: [subcommand, ...args] });
    if (subcommand === "show-options") return "1\n";
    if (subcommand === "display-message") return "4242\n";
    return "";
  }
}

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  Tmux: MockTmux,
  parseFlags: (args: string[], spec: Record<string, unknown>) => {
    const out: Record<string, unknown> & { _: string[] } = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const parser = spec[arg];
      if (!parser) {
        out._.push(arg);
      } else if (parser === Boolean) {
        out[arg] = true;
      } else {
        const value = args[++i];
        if (value === undefined) throw new Error(`option requires argument: ${arg}`);
        out[arg] = parser === Number ? Number(value) : value;
      }
    }
    return out;
  },
}));

const streamModule = await import("../../src/vendor/mpr-plugins/stream/impl.ts?plugin-stream-standalone");
const { default: streamHandler } = await import("../../src/vendor/mpr-plugins/stream/index.ts?plugin-stream-standalone");

beforeEach(() => {
  writes.length = 0;
  calls.length = 0;
  sessions = new Set(["src", "view"]);
  windows = {
    src: [{ index: 2, name: "main" }],
    view: [{ index: 1, name: "existing" }],
  };
});

describe("stream plugin standalone boundary (#2113)", () => {
  test("imports runtime behavior from the SDK boundary", () => {
    const files = ["index.ts", "impl.ts"].map((file) =>
      readFileSync(join(root, "src/vendor/mpr-plugins/stream", file), "utf8"),
    );
    for (const source of files) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|lib|config)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
    const combined = files.join("\n");
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).toContain("Tmux");
    expect(combined).toContain("parseFlags");
  });

  test("cmdStream links a source window with only SDK mocked", async () => {
    const result = await streamModule.cmdStream("src:main", { into: "view", name: "mirror" }, { stdoutWrite: (chunk) => writes.push(chunk) });

    expect(result).toMatchObject({ source: "src:2", into: "view", name: "mirror", target: "view:mirror", renamedSharedWindow: true });
    expect(writes).toEqual(["stream: linked src:2 -> view:mirror (renamed shared window)\n"]);
    expect(calls.map((call) => call.method)).toContain("linkWindow");
    expect(calls.map((call) => call.method)).toContain("renameWindow");
    expect(calls.map((call) => call.method)).toContain("setWindowOption");
  });

  test("handler parses CLI flags through SDK parseFlags", async () => {
    const result = await streamHandler({ source: "cli", args: ["src:2", "--into", "view", "--name", "mirror"] } as any);

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.method === "linkWindow")).toBe(true);
  });

  test("handler supports unlink validation", async () => {
    const result = await streamHandler({ source: "cli", args: ["view:mirror", "--unlink"] } as any);

    expect(result.ok).toBe(true);
    expect(calls).toContainEqual({ method: "unlinkWindow", args: ["view:mirror"] });

    const invalid = await streamHandler({ source: "cli", args: ["view:mirror", "--unlink", "--name", "bad"] } as any);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("--unlink takes only");
  });
});
