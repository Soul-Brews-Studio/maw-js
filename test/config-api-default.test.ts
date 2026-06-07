import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import { createConfigApi, type ConfigApiDeps } from "../src/api/config";

function makeApp(deps: ConfigApiDeps = {}) {
  return new Elysia().use(createConfigApi(deps));
}

function jsonRequest(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(res: Response) {
  return await res.json() as any;
}

describe("config API file routes", () => {
  test("lists maw config and sorted fleet JSON files", async () => {
    const app = makeApp({
      fleetDir: "/fleet",
      readdirSync: ((dir: string) => {
        expect(dir).toBe("/fleet");
        return ["z.txt", "b.json.disabled", "a.json"] as any;
      }) as any,
    });

    const res = await app.handle(new Request("http://localhost/config-files"));

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      files: [
        { name: "maw.config.json", path: "maw.config.json", enabled: true },
        { name: "a.json", path: "fleet/a.json", enabled: true },
        { name: "b.json.disabled", path: "fleet/b.json.disabled", enabled: false },
      ],
    });
  });

  test("lists only maw config when fleet directory cannot be read", async () => {
    const app = makeApp({ readdirSync: (() => { throw new Error("missing fleet"); }) as any });

    const res = await app.handle(new Request("http://localhost/config-files"));

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      files: [{ name: "maw.config.json", path: "maw.config.json", enabled: true }],
    });
  });

  test("lists and reads XDG state fleet files before legacy fallback files", async () => {
    const writes: any[] = [];
    const app = makeApp({
      rootDir: "/root",
      fleetDir: "/state/fleet",
      fleetDirs: ["/state/fleet", "/legacy/fleet"],
      readdirSync: ((dir: string) => {
        if (dir === "/state/fleet") return ["01-state.json", "same.json", "skip.txt"] as any;
        if (dir === "/legacy/fleet") return ["02-legacy.json", "same.json"] as any;
        return [] as any;
      }) as any,
      existsSync: ((path: string) => {
        return [
          "/state/fleet/01-state.json",
          "/state/fleet/same.json",
          "/legacy/fleet/02-legacy.json",
        ].includes(path);
      }) as any,
      readFileSync: ((path: string) => {
        if (path === "/state/fleet/01-state.json") return "{\"source\":\"state\"}";
        if (path === "/state/fleet/same.json") return "{\"source\":\"state-duplicate\"}";
        if (path === "/legacy/fleet/same.json") throw new Error("legacy duplicate should be skipped");
        if (path === "/legacy/fleet/02-legacy.json") return "{\"source\":\"legacy\"}";
        throw new Error(`unexpected read ${path}`);
      }) as any,
      writeFileSync: ((...args: any[]) => { writes.push(args); }) as any,
    });

    expect(await readJson(await app.handle(new Request("http://localhost/config-files")))).toEqual({
      files: [
        { name: "maw.config.json", path: "maw.config.json", enabled: true },
        { name: "01-state.json", path: "fleet/01-state.json", enabled: true },
        { name: "same.json", path: "fleet/same.json", enabled: true },
        { name: "02-legacy.json", path: "fleet/02-legacy.json", enabled: true },
      ],
    });

    expect(await readJson(await app.handle(new Request("http://localhost/config-file?path=fleet/01-state.json")))).toEqual({
      content: "{\"source\":\"state\"}",
    });
    expect(await readJson(await app.handle(new Request("http://localhost/config-file?path=fleet/02-legacy.json")))).toEqual({
      content: "{\"source\":\"legacy\"}",
    });

    const save = await app.handle(jsonRequest("/config-file?path=fleet/new.json", "POST", { content: "{\"ok\":true}" }));
    expect(save.status).toBe(200);
    expect(writes).toEqual([["/state/fleet/new.json", "{\"ok\":true}\n", "utf-8"]]);
  });

  test("GET /config-file validates and reads files", async () => {
    const app = makeApp({
      rootDir: "/root",
      existsSync: ((path: string) => path !== "/root/fleet/missing.json") as any,
      readFileSync: ((path: string) => {
        if (path === "/root/maw.config.json") return JSON.stringify({ env: { SECRET: "raw" }, host: "local" });
        if (path === "/root/fleet/a.json") return "{\"fleet\":true}";
        throw new Error("read boom");
      }) as any,
      configForDisplay: (() => ({ envMasked: { SECRET: "••••" } })) as any,
    });

    expect((await app.handle(new Request("http://localhost/config-file"))).status).toBe(400);
    expect((await readJson(await app.handle(new Request("http://localhost/config-file?path=../x")))).error).toBe("invalid path");
    expect((await app.handle(new Request("http://localhost/config-file?path=fleet/missing.json"))).status).toBe(404);

    const configRes = await app.handle(new Request("http://localhost/config-file?path=maw.config.json"));
    expect(JSON.parse((await readJson(configRes)).content).env).toEqual({ SECRET: "••••" });

    const fleetRes = await app.handle(new Request("http://localhost/config-file?path=fleet/a.json"));
    expect(await readJson(fleetRes)).toEqual({ content: "{\"fleet\":true}" });

    const errorRes = await app.handle(new Request("http://localhost/config-file?path=fleet/boom.json"));
    expect(errorRes.status).toBe(500);
    expect((await readJson(errorRes)).error).toBe("read boom");
  });

  test("POST /config-file validates paths, preserves masked env, and writes fleet files", async () => {
    const writes: any[] = [];
    const saves: any[] = [];
    const app = makeApp({
      rootDir: "/root",
      loadConfig: (() => ({ env: { SECRET: "raw-secret" } })) as any,
      saveConfig: ((data: any) => { saves.push(data); }) as any,
      writeFileSync: ((...args: any[]) => { writes.push(args); }) as any,
    });

    expect((await app.handle(jsonRequest("/config-file", "POST", { content: "{}" }))).status).toBe(400);
    expect((await app.handle(jsonRequest("/config-file?path=other.json", "POST", { content: "{}" }))).status).toBe(403);

    const invalidJson = await app.handle(jsonRequest("/config-file?path=fleet/a.json", "POST", { content: "{bad" }));
    expect(invalidJson.status).toBe(400);

    const mawSave = await app.handle(jsonRequest("/config-file?path=maw.config.json", "POST", {
      content: JSON.stringify({ env: { SECRET: "••••", PLAIN: "value" } }),
    }));
    expect(mawSave.status).toBe(200);
    expect(saves).toEqual([{ env: { SECRET: "raw-secret", PLAIN: "value" } }]);

    const fleetSave = await app.handle(jsonRequest("/config-file?path=fleet/a.json", "POST", { content: "{\"ok\":true}" }));
    expect(fleetSave.status).toBe(200);
    expect(writes).toEqual([["/root/fleet/a.json", "{\"ok\":true}\n", "utf-8"]]);
  });

  test("POST /config-file reports save errors", async () => {
    const app = makeApp({
      saveConfig: (() => { throw new Error("save boom"); }) as any,
    });

    const res = await app.handle(jsonRequest("/config-file?path=maw.config.json", "POST", { content: "{}" }));

    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("save boom");
  });

  test("toggle and delete validate fleet paths and mutate existing files", async () => {
    const renames: any[] = [];
    const unlinks: any[] = [];
    const app = makeApp({
      rootDir: "/root",
      existsSync: ((path: string) => !path.includes("missing")) as any,
      renameSync: ((...args: any[]) => { renames.push(args); }) as any,
      unlinkSync: ((...args: any[]) => { unlinks.push(args); }) as any,
    });

    expect((await app.handle(jsonRequest("/config-file/toggle", "POST"))).status).toBe(400);
    expect((await app.handle(jsonRequest("/config-file/toggle?path=fleet/missing.json", "POST"))).status).toBe(404);

    expect(await readJson(await app.handle(jsonRequest("/config-file/toggle?path=fleet/a.json", "POST")))).toEqual({
      ok: true,
      newPath: "fleet/a.json.disabled",
    });
    expect(await readJson(await app.handle(jsonRequest("/config-file/toggle?path=fleet/a.json.disabled", "POST")))).toEqual({
      ok: true,
      newPath: "fleet/a.json",
    });
    expect(renames).toEqual([
      ["/root/fleet/a.json", "/root/fleet/a.json.disabled"],
      ["/root/fleet/a.json.disabled", "/root/fleet/a.json"],
    ]);

    expect((await app.handle(new Request("http://localhost/config-file", { method: "DELETE" }))).status).toBe(400);
    expect((await app.handle(new Request("http://localhost/config-file?path=fleet/missing.json", { method: "DELETE" }))).status).toBe(404);
    expect(await readJson(await app.handle(new Request("http://localhost/config-file?path=fleet/a.json", { method: "DELETE" })))).toEqual({ ok: true });
    expect(unlinks).toEqual([["/root/fleet/a.json"]]);
  });

  test("PUT /config-file validates names, atomically creates, and reports write conflicts", async () => {
    const writes: any[] = [];
    const app = makeApp({
      fleetDir: "/fleet",
      basename: ((name: string) => name.split("/").pop() ?? name) as any,
      writeFileSync: ((path: string, content: string, options: any) => {
        writes.push([path, content, options]);
        if (path.includes("exists")) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        if (path.includes("boom")) throw new Error("write boom");
      }) as any,
    });

    expect((await app.handle(jsonRequest("/config-file", "PUT", { name: "a.txt", content: "{}" }))).status).toBe(400);
    expect((await app.handle(jsonRequest("/config-file", "PUT", { name: "a.json", content: "{bad" }))).status).toBe(400);

    expect(await readJson(await app.handle(jsonRequest("/config-file", "PUT", { name: "../new.json", content: "{}" })))).toEqual({
      ok: true,
      path: "fleet/new.json",
    });

    const conflict = await app.handle(jsonRequest("/config-file", "PUT", { name: "exists.json", content: "{}" }));
    expect(conflict.status).toBe(409);
    expect(await readJson(conflict)).toEqual({ error: "file already exists" });

    const boom = await app.handle(jsonRequest("/config-file", "PUT", { name: "boom.json", content: "{}" }));
    expect(boom.status).toBe(500);
    expect(writes[0]).toEqual(["/fleet/new.json", "{}\n", { encoding: "utf-8", flag: "wx" }]);
  });
});

describe("config API pin and public config routes", () => {
  test("pin info, set, verify, reset, and rate-limit branches", async () => {
    const saves: any[] = [];
    const attempts = new Map<string, { count: number; resetAt: number }>();
    let pin = "";
    let tick = 1_000;
    const app = makeApp({
      pinAttempts: attempts,
      now: () => tick,
      loadConfig: (() => ({ pin, env: { SECRET: "raw-secret" } })) as any,
      saveConfig: ((data: any) => { saves.push(data); pin = data.pin ?? pin; }) as any,
      createToken: () => "token-123",
    });

    expect(await readJson(await app.handle(new Request("http://localhost/pin-info")))).toEqual({ length: 0, enabled: false });
    expect(await readJson(await app.handle(jsonRequest("/pin-set", "POST", { pin: "a1-2b3" })))).toEqual({
      ok: true,
      length: 3,
      enabled: true,
    });
    expect(saves).toEqual([{ pin: "123" }]);

    expect(await readJson(await app.handle(jsonRequest("/pin-verify", "POST", { pin: "000" })))).toEqual({ ok: false });
    expect(await readJson(await app.handle(jsonRequest("/pin-verify", "POST", { pin: "123" })))).toEqual({ ok: true, token: "token-123" });
    expect(attempts.has("local")).toBe(false);

    pin = "";
    expect(await readJson(await app.handle(jsonRequest("/pin-verify", "POST", { pin: "anything" }, { "x-forwarded-for": "proxy" })))).toEqual({ ok: true });

    pin = "9";
    for (let i = 0; i < 5; i++) {
      expect((await app.handle(jsonRequest("/pin-verify", "POST", { pin: "bad" }, { "cf-connecting-ip": "rate" }))).status).toBe(200);
    }
    const limited = await app.handle(jsonRequest("/pin-verify", "POST", { pin: "bad" }, { "cf-connecting-ip": "rate" }));
    expect(limited.status).toBe(429);

    attempts.set("old", { count: 5, resetAt: 10 });
    tick = 70_000;
    const reset = await app.handle(jsonRequest("/pin-verify", "POST", { pin: "bad" }, { "cf-connecting-ip": "old" }));
    expect(reset.status).toBe(200);
    expect(attempts.get("old")?.count).toBe(1);
  });

  test("default pin verifier uses auth token factory when no override is provided", async () => {
    const previousSecret = process.env.MAW_JWT_SECRET;
    process.env.MAW_JWT_SECRET = "test-config-api-default-pin-secret";
    try {
      const app = makeApp({
        pinAttempts: new Map(),
        loadConfig: (() => ({ pin: "42" })) as any,
      });

      const res = await app.handle(jsonRequest("/pin-verify", "POST", { pin: "42" }));
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(10);
    } finally {
      if (previousSecret === undefined) delete process.env.MAW_JWT_SECRET;
      else process.env.MAW_JWT_SECRET = previousSecret;
    }
  });

  test("GET and POST /config preserve masked env values and report save errors", async () => {
    const saves: any[] = [];
    const app = makeApp({
      loadConfig: (() => ({ raw: true, env: { SECRET: "raw-secret" } })) as any,
      configForDisplay: (() => ({ display: true, envMasked: { SECRET: "••••" } })) as any,
      saveConfig: ((data: any) => { saves.push(data); }) as any,
    });

    expect(await readJson(await app.handle(new Request("http://localhost/config?raw=1")))).toEqual({ raw: true, env: { SECRET: "raw-secret" } });
    expect(await readJson(await app.handle(new Request("http://localhost/config")))).toEqual({ display: true, envMasked: { SECRET: "••••" } });

    const save = await app.handle(jsonRequest("/config", "POST", { env: { SECRET: "••••", PLAIN: "ok" } }));
    expect(save.status).toBe(200);
    expect(saves).toEqual([{ env: { SECRET: "raw-secret", PLAIN: "ok" } }]);

    const failing = makeApp({ saveConfig: (() => { throw new Error("config save boom"); }) as any });
    const error = await failing.handle(jsonRequest("/config", "POST", { host: "local" }));
    expect(error.status).toBe(400);
    expect((await readJson(error)).error).toBe("config save boom");
  });
});
