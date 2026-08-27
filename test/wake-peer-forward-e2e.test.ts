import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSessionsApi } from "../src/api/sessions";
import { invokeDirectHandler } from "../src/cli/top-aliases";

/**
 * E2E (Riddler gate b): the FULL cross-node PL wake chain carries the worker
 * fields. `maw wake win:<repo> --work --wt X -e codex-pl-worker --wait`
 *   → direct handler resolves the `win:` peer prefix
 *   → real forwardToPeer builds the body + real HTTP POST /api/wake
 *   → the REAL /api/wake handler validates WakeBody + maps to cmdWake
 *   → captured cmdWake opts contain EXACTLY the PL fields.
 * Before the fix the receiver bound only {target,oracle,task}, so `--work --wt
 * -e --wait` were dropped (captured opts = {noAttach,task}).
 */

let server: ReturnType<typeof Bun.serve>;
let peersDir: string;
let captured: { target?: string; opts?: any };
const prevPeersFile = process.env.PEERS_FILE;
const prevTransport = process.env.MAW_CURL_FETCH_TRANSPORT;

beforeAll(() => {
  captured = {};
  // Real /api/wake receiver with an injected cmdWake capture.
  const app = new Elysia({ prefix: "/api" }).use(createSessionsApi({
    cmdWake: async (target: string, opts: any) => { captured = { target, opts }; return {}; },
    shouldAutoWake: () => ({ wake: true } as any),
  }));
  server = Bun.serve({ port: 0, fetch: app.fetch });

  // Temp peers store so resolvePeer("win") → the loopback receiver.
  peersDir = mkdtempSync(join(tmpdir(), "peerwake-e2e-"));
  const peersFile = join(peersDir, "peers.json");
  writeFileSync(peersFile, JSON.stringify({ peers: { win: { url: `http://localhost:${server.port}`, node: "win" } } }));
  process.env.PEERS_FILE = peersFile;
  process.env.MAW_CURL_FETCH_TRANSPORT = "native"; // deterministic HTTP in tests
});

afterAll(() => {
  server?.stop(true);
  rmSync(peersDir, { recursive: true, force: true });
  if (prevPeersFile === undefined) delete process.env.PEERS_FILE; else process.env.PEERS_FILE = prevPeersFile;
  if (prevTransport === undefined) delete process.env.MAW_CURL_FETCH_TRANSPORT; else process.env.MAW_CURL_FETCH_TRANSPORT = prevTransport;
});

describe("PL wake fields survive the full cross-node chain", () => {
  test("maw wake win:<repo> --work --wt X -e codex-pl-worker --wait → cmdWake gets exactly those", async () => {
    await invokeDirectHandler(
      "../commands/shared/wake-cmd:cmdWake",
      ["win:TTT3P/xnode-probe", "--work", "--wt", "X", "-e", "codex-pl-worker", "--wait"],
      { log: () => {}, error: () => {} },
    );

    expect(captured.target).toBe("TTT3P/xnode-probe");
    expect(captured.opts).toMatchObject({
      noAttach: true,
      sessionMode: "work",
      wt: "X",
      engine: "codex-pl-worker",
      wait: true,
    });
  });

  test("an unknown/hostile key never reaches cmdWake (untrusted peer guard)", async () => {
    // WakeBody's additionalProperties:false + the handler mapping only named
    // fields together guarantee an untrusted peer cannot smuggle a raw cmdWake
    // option. Whether Elysia strips the extra key (200) or rejects it (4xx),
    // `evil` must never reach cmdWake and noAttach stays forced true.
    captured = {};
    const res = await fetch(`http://localhost:${server.port}/api/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "x", work: true, evil: "rm -rf", noAttach: false }),
    });
    if (captured.opts) {
      expect(captured.opts).not.toHaveProperty("evil");
      expect(captured.opts.noAttach).toBe(true);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
