/** Targeted coverage for src/vendor/mpr-plugins/ui/impl-render.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let distInstalled = false;
let srcDir: string | null = null;
let resolvedPeers = new Map<string, string | null>();
let installCalls: Array<string | undefined> = [];
let statusCalls = 0;
let logs: string[] = [];

const originalUser = process.env.USER;
const originalLog = console.log;

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/ui/impl-helpers.ts"), () => ({
  LENS_PORT: 5173,
  MAW_PORT: 3456,
  isUiDistInstalled: () => distInstalled,
  findMawUiSrcDir: () => srcDir,
  buildDevCommand: (mawUiDir: string) => `cd ${mawUiDir} && bun run dev`,
  buildLensUrl: (opts: { remoteHost?: string; threeD?: boolean; port?: number }) => {
    const port = opts.port ?? 5173;
    const page = opts.threeD ? "federation.html" : "federation_2d.html";
    const base = `http://localhost:${port}/${page}`;
    return opts.remoteHost ? `${base}?host=${encodeURIComponent(opts.remoteHost)}` : base;
  },
  resolvePeerHostPort: (peer: string) => resolvedPeers.get(peer) ?? null,
  justHost: (hostPort: string) => hostPort.split(":")[0],
  buildTunnelCommand: ({ user, host }: { user: string; host: string }) =>
    `ssh -N -L 5173:localhost:5173 -L 3456:localhost:3456 ${user}@${host}`,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/ui/ui-install.ts"), () => ({
  cmdUiInstall: async (version?: string) => { installCalls.push(version); },
  cmdUiStatus: async () => { statusCalls += 1; },
}));

const { cmdUi, parseUiArgs, renderUiOutput } = await import(
  "../../src/vendor/mpr-plugins/ui/impl-render.ts?ui-impl-render-coverage"
);

beforeEach(() => {
  distInstalled = false;
  srcDir = null;
  resolvedPeers = new Map<string, string | null>();
  installCalls = [];
  statusCalls = 0;
  logs = [];
  process.env.USER = "testuser";
  console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
});

afterEach(() => {
  console.log = originalLog;
  if (originalUser === undefined) delete process.env.USER;
  else process.env.USER = originalUser;
});

describe("ui impl render coverage", () => {
  test("parseUiArgs accepts subcommands, flags, version, and first positional peer", () => {
    expect(parseUiArgs(["install", "--version", "v1.2.3", "ignored-peer"])).toEqual({
      peer: "ignored-peer",
      install: undefined,
      tunnel: undefined,
      dev: undefined,
      threeD: undefined,
      subcommand: "install",
      version: "v1.2.3",
    });

    expect(parseUiArgs(["status"])).toMatchObject({ subcommand: "status" });
    expect(parseUiArgs(["oracle-world", "--tunnel", "--3d", "--install"])).toMatchObject({
      peer: "oracle-world",
      tunnel: true,
      threeD: true,
      install: true,
      subcommand: undefined,
    });
  });

  test("bare output uses vite lens by default and maw-js port when ui dist is installed", () => {
    expect(renderUiOutput({})).toBe("http://localhost:5173/federation_2d.html");

    distInstalled = true;
    expect(renderUiOutput({ threeD: true })).toBe("http://localhost:3456/federation.html");
  });

  test("dev output reports missing source or prints start command and 3d dev URL", () => {
    expect(renderUiOutput({ dev: true })).toContain("# maw-ui source not found. Searched:");

    srcDir = "/tmp/maw-ui";
    const output = renderUiOutput({ dev: true, threeD: true });
    expect(output).toContain("# Start vite dev server (HMR on :5173, proxy /api → maw serve on :3456):");
    expect(output).toContain("cd /tmp/maw-ui && bun run dev");
    expect(output).toContain("http://localhost:5173/federation.html");
    expect(output).toContain("# Edit files in /tmp/maw-ui — vite hot-reloads instantly.");
  });

  test("tunnel output covers usage, unknown peer, resolved peer, user fallback, and Shape A dist note", () => {
    expect(renderUiOutput({ tunnel: true })).toBe([
      "# usage: maw ui --tunnel <peer>",
      "# example: maw ui --tunnel oracle-world",
    ].join("\n"));

    expect(renderUiOutput({ tunnel: true, peer: "missing" })).toContain("# unknown peer: missing");

    resolvedPeers.set("clinic", "clinic.local:3456");
    delete process.env.USER;
    const noDistOutput = renderUiOutput({ tunnel: true, peer: "clinic" });
    expect(noDistOutput).toContain("# Run this on your local machine to forward both lens (5173) and maw-js (3456):");
    expect(noDistOutput).toContain("ssh -N -L 5173:localhost:5173 -L 3456:localhost:3456 neo@clinic.local");
    expect(noDistOutput).not.toContain("Shape A");

    distInstalled = true;
    process.env.USER = "testuser";
    resolvedPeers.set("oracle-world", "oracle-world.local:3456");
    const output = renderUiOutput({ tunnel: true, peer: "oracle-world", threeD: true });
    expect(output).toContain("# Run this on your local machine to forward both lens (3456) and maw-js (3456):");
    expect(output).toContain("ssh -N -L 5173:localhost:5173 -L 3456:localhost:3456 testuser@oracle-world.local");
    expect(output).toContain("http://localhost:3456/federation.html");
    expect(output).toContain("# (Shape A — maw-ui dist served from maw-js on port 3456)");
  });

  test("peer output resolves known peers and rejects unknown peers", () => {
    expect(renderUiOutput({ peer: "missing" })).toBe([
      "# unknown peer: missing",
      "# expected a named peer (config.namedPeers) or literal host:port",
    ].join("\n"));

    resolvedPeers.set("clinic", "clinic.local:4444");
    expect(renderUiOutput({ peer: "clinic", threeD: true })).toBe(
      "http://localhost:5173/federation.html?host=clinic.local%3A4444"
    );
  });

  test("cmdUi dispatches install/status modules or logs rendered output", async () => {
    await cmdUi(["install", "--version", "v9.9.9"]);
    await cmdUi(["--install", "legacy-version"]);
    await cmdUi(["status"]);
    await cmdUi(["--3d"]);

    expect(installCalls).toEqual(["v9.9.9", "legacy-version"]);
    expect(statusCalls).toBe(1);
    expect(logs).toEqual(["http://localhost:5173/federation.html"]);
  });
});
