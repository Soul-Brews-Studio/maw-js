import { beforeEach, describe, expect, test } from "bun:test";
import {
  cmdStream,
  STREAM_USAGE,
  type StreamDeps,
} from "../../src/vendor/mpr-plugins/stream/impl.ts?stream-impl-coverage";

type WindowRow = { index: number; name: string };

class FakeTmux {
  sessions = new Set<string>();
  windows: Record<string, WindowRow[]> = {};
  calls: string[] = [];
  current = "50-mawjs";
  sourcePid = "100";
  destPid = "100";
  baseIndex = 0;
  failLink = false;
  failCurrent = false;

  async hasSession(name: string): Promise<boolean> {
    this.calls.push(`hasSession ${name}`);
    return this.sessions.has(name);
  }

  async listWindows(session: string): Promise<WindowRow[]> {
    this.calls.push(`listWindows ${session}`);
    if (!this.sessions.has(session)) throw new Error("can't find session");
    return this.windows[session].map(w => ({ ...w }));
  }

  async newSession(name: string, opts?: { window?: string; detached?: boolean }): Promise<string> {
    this.calls.push(`newSession ${name} window=${opts?.window ?? ""} detached=${opts?.detached ?? false}`);
    this.sessions.add(name);
    this.windows[name] = [{ index: 0, name: opts?.window ?? "zsh" }];
    return name;
  }

  async killSession(name: string): Promise<void> {
    this.calls.push(`killSession ${name}`);
    this.sessions.delete(name);
    delete this.windows[name];
  }

  async killWindow(target: string): Promise<void> {
    this.calls.push(`killWindow ${target}`);
    const { session, window } = parseTarget(target);
    this.windows[session] = (this.windows[session] ?? []).filter(w => String(w.index) !== window && w.name !== window);
  }

  async linkWindow(source: string, target: string, opts?: { detached?: boolean }): Promise<void> {
    this.calls.push(`linkWindow ${source} -> ${target} detached=${opts?.detached ?? false}`);
    if (this.failLink) throw new Error("link failed");
    const sourceParsed = parseTarget(source);
    const targetParsed = parseTarget(target);
    const sourceWindow = this.windows[sourceParsed.session]?.find(w => String(w.index) === sourceParsed.window || w.name === sourceParsed.window);
    if (!sourceWindow) throw new Error("source missing");
    this.windows[targetParsed.session].push({ index: Number(targetParsed.window), name: sourceWindow.name });
  }

  async unlinkWindow(target: string): Promise<void> {
    this.calls.push(`unlinkWindow ${target}`);
  }

  async renameWindow(target: string, name: string): Promise<void> {
    this.calls.push(`renameWindow ${target} ${name}`);
    const { session, window } = parseTarget(target);
    const row = this.windows[session].find(w => String(w.index) === window || w.name === window);
    if (row) row.name = name;
  }

  async setWindowOption(target: string, option: string, value: string): Promise<void> {
    this.calls.push(`setWindowOption ${target} ${option}=${value}`);
  }

  async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
    this.calls.push(`run ${[subcommand, ...args].join(" ")}`);
    if (this.failCurrent) throw new Error("not in tmux");
    if (subcommand === "display-message" && args.includes("#{session_name}")) return `${this.current}\n`;
    if (subcommand === "display-message" && args.includes("#{pid}")) {
      const target = String(args[1] ?? "");
      return target.endsWith(":") ? `${this.destPid}\n` : `${this.sourcePid}\n`;
    }
    if (subcommand === "show-options") return `${this.baseIndex}\n`;
    return "";
  }
}

function parseTarget(target: string): { session: string; window: string } {
  const [session, window] = target.split(":", 2);
  return { session, window };
}

let fake: FakeTmux;
let out: string[];

function deps(): Partial<StreamDeps> {
  return {
    tmux: fake as unknown as StreamDeps["tmux"],
    stdoutWrite: (chunk) => { out.push(chunk); },
  };
}

function addSession(name: string, windows: WindowRow[]) {
  fake.sessions.add(name);
  fake.windows[name] = windows.map(w => ({ ...w }));
}

beforeEach(() => {
  fake = new FakeTmux();
  out = [];
  addSession("50-mawjs", [{ index: 2, name: "mawjs-features" }]);
});

describe("maw stream impl", () => {
  test("creates the default view session and links by source name", async () => {
    const result = await cmdStream("50-mawjs:mawjs-features", {}, deps());

    expect(result).toEqual({
      source: "50-mawjs:2",
      into: "50-mawjs-view",
      name: "mawjs-features",
      target: "50-mawjs-view:mawjs-features",
      createdDestination: true,
      renamedSharedWindow: false,
    });
    expect(out.join("")).toBe("stream: linked 50-mawjs:2 -> 50-mawjs-view:mawjs-features (created destination)\n");
    expect(fake.calls).toEqual([
      "listWindows 50-mawjs",
      "run display-message -p #{session_name}",
      "hasSession 50-mawjs-view",
      "newSession 50-mawjs-view window=maw-stream-placeholder detached=true",
      "listWindows 50-mawjs-view",
      "listWindows 50-mawjs-view",
      "run display-message -t 50-mawjs:2 -p #{pid}",
      "run display-message -t 50-mawjs-view: -p #{pid}",
      "run show-options -t 50-mawjs-view -gv base-index",
      "linkWindow 50-mawjs:2 -> 50-mawjs-view:1 detached=true",
      "setWindowOption 50-mawjs-view:1 @maw-linked-from=50-mawjs:2",
      "killWindow 50-mawjs-view:0",
    ]);
  });

  test("links into an explicit destination with a requested alias", async () => {
    addSession("observer", [{ index: 0, name: "main" }]);

    const result = await cmdStream("50-mawjs:2", { into: "observer", name: "features-copy" }, deps());

    expect(result).toMatchObject({
      source: "50-mawjs:2",
      into: "observer",
      name: "features-copy",
      target: "observer:features-copy",
      createdDestination: false,
      renamedSharedWindow: true,
    });
    expect(out.join("")).toBe("stream: linked 50-mawjs:2 -> observer:features-copy (renamed shared window)\n");
    expect(fake.calls).toContain("linkWindow 50-mawjs:2 -> observer:1 detached=true");
    expect(fake.calls).toContain("renameWindow observer:1 features-copy");
    expect(fake.calls).toContain("setWindowOption observer:1 @maw-linked-from=50-mawjs:2");
    expect(fake.calls).not.toContain("newSession observer window=maw-stream-placeholder detached=true");
  });

  test("respects destination base-index when choosing the linked window slot", async () => {
    fake.baseIndex = 1;
    addSession("observer", [{ index: 1, name: "main" }]);

    await cmdStream("50-mawjs:2", { into: "observer", name: "features-copy" }, deps());

    expect(fake.calls).toContain("run show-options -t observer -gv base-index");
    expect(fake.calls).toContain("linkWindow 50-mawjs:2 -> observer:2 detached=true");
    expect(fake.calls).toContain("renameWindow observer:2 features-copy");
  });

  test("unlinks a mirrored window by destination target", async () => {
    const result = await cmdStream("observer:features-copy", { unlink: true }, deps());

    expect(result).toEqual({
      into: "observer",
      name: "features-copy",
      target: "observer:features-copy",
      unlinked: true,
    });
    expect(fake.calls).toEqual(["unlinkWindow observer:features-copy"]);
    expect(out.join("")).toBe("stream: unlinked observer:features-copy\n");
  });

  test("rejects collisions, ambiguous sources, pane targets, and missing explicit destinations", async () => {
    addSession("observer", [{ index: 0, name: "mawjs-features" }]);
    await expect(cmdStream("50-mawjs:mawjs-features", { into: "observer" }, deps()))
      .rejects.toThrow("use --name <alias>");

    addSession("dupes", [{ index: 0, name: "same" }, { index: 3, name: "same" }]);
    await expect(cmdStream("dupes:same", { into: "observer", name: "copy" }, deps()))
      .rejects.toThrow("is ambiguous");

    await expect(cmdStream("50-mawjs:mawjs-features.0", { into: "observer" }, deps()))
      .rejects.toThrow("not a pane");

    await expect(cmdStream("50-mawjs:mawjs-features", { into: "missing" }, deps()))
      .rejects.toThrow("destination session 'missing' not found");

    await expect(cmdStream("missing:main", { into: "observer" }, deps()))
      .rejects.toThrow("source session 'missing' not found");
  });

  test("uses the current view session as destination without auto-creating another view", async () => {
    fake.current = "50-mawjs-view";
    addSession("50-mawjs-view", [{ index: 4, name: "watch" }]);

    const result = await cmdStream("50-mawjs:2", { name: "features-copy" }, deps());

    expect(result.into).toBe("50-mawjs-view");
    expect(fake.calls).toContain("hasSession 50-mawjs-view");
    expect(fake.calls).not.toContain("newSession 50-mawjs-view window=maw-stream-placeholder detached=true");
  });

  test("cleans up an auto-created destination on link failure", async () => {
    fake.failLink = true;

    await expect(cmdStream("50-mawjs:2", {}, deps())).rejects.toThrow("link failed");

    expect(fake.calls).toContain("newSession 50-mawjs-view window=maw-stream-placeholder detached=true");
    expect(fake.calls).toContain("killSession 50-mawjs-view");
    expect(fake.sessions.has("50-mawjs-view")).toBe(false);
  });

  test("rejects cross-server links before calling link-window", async () => {
    fake.destPid = "200";

    await expect(cmdStream("50-mawjs:2", {}, deps())).rejects.toThrow("same tmux server");

    expect(fake.calls).toContain("run display-message -t 50-mawjs:2 -p #{pid}");
    expect(fake.calls).toContain("run display-message -t 50-mawjs-view: -p #{pid}");
    expect(fake.calls.some(call => call.startsWith("linkWindow "))).toBe(false);
    expect(fake.calls).toContain("killSession 50-mawjs-view");
  });

  test("requires --into outside tmux and validates target shape", async () => {
    fake.failCurrent = true;

    await expect(cmdStream("50-mawjs:2", {}, deps())).rejects.toThrow("--into is required outside tmux");
    await expect(cmdStream("", {}, deps())).rejects.toThrow(STREAM_USAGE);
    await expect(cmdStream("50-mawjs", {}, deps())).rejects.toThrow("target must be <session>:<window>");
    await expect(cmdStream("50-mawjs:2", { into: "bad:session" }, deps())).rejects.toThrow("invalid destination session");
    await expect(cmdStream("50-mawjs:2", { into: "observer", name: "-bad" }, deps())).rejects.toThrow("invalid window alias");
  });
});
