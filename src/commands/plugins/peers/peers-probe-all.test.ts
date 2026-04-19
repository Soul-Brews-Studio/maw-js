/**
 * maw peers probe-all — parallel federation ping tests (#669).
 *
 * Kept in its own file (parallel with peers-probe.test.ts) to respect
 * CONTRIBUTING's per-file size cap and keep subcommand coverage grouped.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
const servers: Array<{ stop: (force?: boolean) => void }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-peers-probe-all-"));
  process.env.PEERS_FILE = join(dir, "peers.json");
});
afterEach(() => {
  for (const s of servers.splice(0)) {
    try { s.stop(true); } catch { /* ignore */ }
  }
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
});

function spawnInfoServer(node: string, opts: { status?: number } = {}): { port: number } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/info") {
        if (opts.status && opts.status >= 400) {
          return new Response("bad", { status: opts.status });
        }
        return Response.json({ node, maw: true });
      }
      return new Response("nope", { status: 404 });
    },
  });
  servers.push(server);
  return { port: server.port };
}

describe("cmdProbeAll — 3-peer mixed fleet (2 ok, 1 fail)", () => {
  it("returns a row per peer with ok/ms/error and worstExitCode set to the failure family", async () => {
    const a = spawnInfoServer("alpha");
    const b = spawnInfoServer("bravo");
    const { cmdAdd } = await import("./impl");
    await cmdAdd({ alias: "a", url: `http://127.0.0.1:${a.port}` });
    await cmdAdd({ alias: "b", url: `http://127.0.0.1:${b.port}` });
    await cmdAdd({
      alias: "c",
      url: "http://does-not-exist.invalid:9999",
      node: "manual",
    });

    const { cmdProbeAll } = await import("./probe-all");
    const r = await cmdProbeAll(1500);

    expect(r.rows).toHaveLength(3);
    expect(r.okCount).toBe(2);
    expect(r.failCount).toBe(1);
    // DNS → exit code 3 per PROBE_EXIT_CODES.
    expect(r.worstExitCode).toBe(3);

    const rowA = r.rows.find(x => x.alias === "a")!;
    const rowB = r.rows.find(x => x.alias === "b")!;
    const rowC = r.rows.find(x => x.alias === "c")!;

    expect(rowA.ok).toBe(true);
    expect(rowA.node).toBe("alpha");
    expect(rowA.ms).toBeGreaterThanOrEqual(0);
    expect(rowA.error).toBeUndefined();

    expect(rowB.ok).toBe(true);
    expect(rowB.node).toBe("bravo");

    expect(rowC.ok).toBe(false);
    expect(rowC.error?.code).toBe("DNS");
  });

  it("persists lastSeen on success and lastError on failure in a single store mutation", async () => {
    const a = spawnInfoServer("alpha");
    const { cmdAdd, cmdInfo } = await import("./impl");
    await cmdAdd({ alias: "a", url: `http://127.0.0.1:${a.port}` });
    await cmdAdd({ alias: "c", url: "http://does-not-exist.invalid:9999", node: "manual" });

    const { cmdProbeAll } = await import("./probe-all");
    await cmdProbeAll(1500);

    const infoA = cmdInfo("a")!;
    const infoC = cmdInfo("c")!;
    expect(infoA.lastError).toBeUndefined();
    expect(infoA.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(infoC.lastError?.code).toBe("DNS");
    expect(infoC.node).toBe("manual"); // not overwritten on failure
  });

  it("empty peers.json → no rows, worstExitCode 0, okCount 0", async () => {
    const { cmdProbeAll } = await import("./probe-all");
    const r = await cmdProbeAll(1500);
    expect(r.rows).toEqual([]);
    expect(r.okCount).toBe(0);
    expect(r.failCount).toBe(0);
    expect(r.worstExitCode).toBe(0);
  });
});

describe("formatProbeAll", () => {
  it("renders header + row per peer + ok/fail footer", async () => {
    const { formatProbeAll } = await import("./probe-all");
    const out = formatProbeAll({
      rows: [
        { alias: "a", url: "http://a", node: "alpha", lastSeen: "2026-04-19T00:00:00Z", ok: true, ms: 42 },
        {
          alias: "c", url: "http://c", node: "manual", lastSeen: null, ok: false, ms: 1500,
          error: { code: "DNS", message: "x", at: "2026-04-19T00:00:00Z" },
        },
      ],
      okCount: 1,
      failCount: 1,
      worstExitCode: 3,
    });

    expect(out).toContain("alias");
    expect(out).toContain("result");
    expect(out).toContain("a");
    expect(out).toContain("http://a");
    expect(out).toContain("ok (42ms)");
    expect(out).toContain("DNS");
    expect(out).toContain("1/2 ok, 1 failed");
  });

  it("'no peers' banner when rows empty", async () => {
    const { formatProbeAll } = await import("./probe-all");
    const out = formatProbeAll({ rows: [], okCount: 0, failCount: 0, worstExitCode: 0 });
    expect(out).toBe("no peers");
  });
});

describe("dispatcher — probe-all subcommand", () => {
  it("all peers ok → ok:true, exitCode undefined, table printed", async () => {
    const a = spawnInfoServer("alpha");
    const b = spawnInfoServer("bravo");
    const { default: handler } = await import("./index");
    await handler({ source: "cli", args: ["add", "a", `http://127.0.0.1:${a.port}`] });
    await handler({ source: "cli", args: ["add", "b", `http://127.0.0.1:${b.port}`] });

    const res = await handler({ source: "cli", args: ["probe-all"] });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain("a");
    expect(res.output).toContain("b");
    expect(res.output).toContain("2/2 ok");
  });

  it("any peer fails → ok:false with DNS exitCode 3 (fail loud)", async () => {
    const a = spawnInfoServer("alpha");
    const { default: handler } = await import("./index");
    await handler({ source: "cli", args: ["add", "a", `http://127.0.0.1:${a.port}`] });
    await handler({
      source: "cli",
      args: ["add", "c", "http://does-not-exist.invalid:9999", "--allow-unreachable"],
    });

    const res = await handler({ source: "cli", args: ["probe-all", "--timeout", "1500"] });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
    expect(res.error).toContain("probe-all");
    expect(res.error).toContain("--allow-unreachable");
    expect(res.output).toContain("1/2 ok, 1 failed");
  });

  it("--allow-unreachable → ok:true even when peers fail", async () => {
    const { default: handler } = await import("./index");
    await handler({
      source: "cli",
      args: ["add", "c", "http://does-not-exist.invalid:9999", "--allow-unreachable"],
    });

    const res = await handler({
      source: "cli",
      args: ["probe-all", "--timeout", "1500", "--allow-unreachable"],
    });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain("0/1 ok, 1 failed");
  });

  it("rejects non-numeric / non-positive --timeout", async () => {
    const { default: handler } = await import("./index");
    const bad = await handler({ source: "cli", args: ["probe-all", "--timeout", "nope"] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("--timeout");

    const zero = await handler({ source: "cli", args: ["probe-all", "--timeout", "0"] });
    expect(zero.ok).toBe(false);
    expect(zero.error).toContain("--timeout");
  });

  it("empty peers.json → ok:true, 'no peers' printed, no failure", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({ source: "cli", args: ["probe-all"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("no peers");
  });

  it("help lists probe-all", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({ source: "cli", args: [] });
    expect(res.output).toContain("probe-all");
  });
});
