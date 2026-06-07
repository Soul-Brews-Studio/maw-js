import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createPluginDownloadApi, createPluginTarStream } from "../src/api/plugin-download";
import type { LoadedPlugin } from "../src/plugin/types";

class FakeEmitter {
  private handlers = new Map<string, Function[]>();

  on(event: string, fn: Function) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(fn);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

class FakeChild extends FakeEmitter {
  stdout = new FakeEmitter();
  killed: string[] = [];

  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
}

type ChildMode = "success" | "idle" | "spawn-error" | "tar-exit" | "closed-then-error";

function plugin(name = "hello", version = "1.2.3", dir = `/plugins/${name}`): LoadedPlugin {
  return {
    dir,
    wasmPath: "",
    kind: "ts",
    manifest: {
      name,
      version,
      sdk: "^1.0.0",
      entry: "index.ts",
    },
  };
}

function appWith(opts: {
  plugins?: LoadedPlugin[];
  symlink?: boolean;
  lstatThrows?: boolean;
  mode?: ChildMode;
  spawned?: FakeChild[];
  calls?: Array<{ command: string; args: string[] }>;
}) {
  const spawned = opts.spawned ?? [];
  const calls = opts.calls ?? [];
  const app = new Elysia({ prefix: "/api" }).use(createPluginDownloadApi({
    discoverPackages: () => opts.plugins ?? [],
    lstatSync: ((path: string) => {
      if (opts.lstatThrows) throw new Error(`missing ${path}`);
      return { isSymbolicLink: () => opts.symlink ?? false };
    }) as any,
    spawn: ((command: string, args: string[]) => {
      const child = new FakeChild();
      spawned.push(child);
      calls.push({ command, args });
      queueMicrotask(() => {
        if (opts.mode === "idle") return;
        if (opts.mode === "spawn-error") {
          child.emit("error", new Error("spawn failed"));
          return;
        }
        if (opts.mode === "tar-exit") {
          child.emit("exit", 2);
          return;
        }
        if (opts.mode === "closed-then-error") {
          child.stdout.emit("end");
          child.emit("error", new Error("late error"));
          child.emit("exit", 3);
          return;
        }
        child.stdout.emit("data", Buffer.from("tgz-bytes"));
        child.stdout.emit("end");
        child.emit("exit", 0);
      });
      return child;
    }) as any,
  }));
  return { app, spawned, calls };
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

describe("plugin download API default-suite coverage", () => {
  test("default router factory is constructible", () => {
    expect(createPluginDownloadApi()).toBeInstanceOf(Elysia);
  });

  test("returns 404 when plugin is not installed", async () => {
    const { app, calls } = appWith({ plugins: [] });

    const res = await app.handle(new Request("http://local/api/plugin/download/missing"));

    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "plugin not installed", name: "missing" });
    expect(calls).toEqual([]);
  });

  test("rejects symlinked dev installs before spawning tar", async () => {
    const { app, calls } = appWith({ plugins: [plugin()], symlink: true });

    const res = await app.handle(new Request("http://local/api/plugin/download/hello"));

    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      error: "plugin is --link (dev install) — rebuild + re-install a real artifact before serving",
      name: "hello",
    });
    expect(calls).toEqual([]);
  });

  test("streams tar output with download headers and falls through lstat failures", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const entry = plugin("hello", "2.0.0", "/real/hello");
    const { app } = appWith({ plugins: [entry], lstatThrows: true, calls });

    const res = await app.handle(new Request("http://local/api/plugin/download/hello"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/gzip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="hello-2.0.0.tgz"');
    expect(await res.text()).toBe("tgz-bytes");
    expect(calls).toEqual([{ command: "tar", args: ["-czf", "-", "-C", "/real/hello", "."] }]);
  });

  test("plugin tar stream propagates child data, errors, and non-zero tar exits", async () => {
    const success = new FakeChild();
    let text = new Response(createPluginTarStream(success as any)).text();
    success.stdout.emit("data", Buffer.from("tgz-bytes"));
    success.stdout.emit("end");
    expect(await text).toBe("tgz-bytes");

    const spawnError = new FakeChild();
    text = new Response(createPluginTarStream(spawnError as any)).text();
    spawnError.emit("error", new Error("spawn failed"));
    await expect(text).rejects.toThrow("spawn failed");

    const tarExit = new FakeChild();
    text = new Response(createPluginTarStream(tarExit as any)).text();
    tarExit.emit("exit", 2);
    await expect(text).rejects.toThrow("tar exited with code 2");
  });

  test("plugin tar stream ignores child errors after close and cancels tar", async () => {
    const closed = new FakeChild();
    const text = new Response(createPluginTarStream(closed as any)).text();
    closed.stdout.emit("end");
    closed.emit("error", new Error("late error"));
    closed.emit("exit", 3);
    expect(await text).toBe("");

    const cancelled = new FakeChild();
    await createPluginTarStream(cancelled as any).cancel();
    expect(cancelled.killed).toEqual(["SIGTERM"]);
  });
});
