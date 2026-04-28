/**
 * Tests for src/commands/plugins/ui/impl-helpers.ts — pure helpers.
 * justHost, buildDevCommand, buildLensUrl, buildTunnelCommand.
 */
import { describe, it, expect } from "bun:test";
import {
  justHost,
  buildDevCommand,
  buildLensUrl,
  buildTunnelCommand,
  LENS_PORT,
  MAW_PORT,
  LENS_PAGE_2D,
  LENS_PAGE_3D,
} from "../../src/commands/plugins/ui/impl-helpers";

describe("justHost", () => {
  it("extracts host from host:port", () => {
    expect(justHost("example.com:3456")).toBe("example.com");
  });

  it("returns host when no port", () => {
    expect(justHost("example.com")).toBe("example.com");
  });

  it("handles IP address", () => {
    expect(justHost("192.168.1.1:8080")).toBe("192.168.1.1");
  });

  it("handles localhost", () => {
    expect(justHost("localhost:3456")).toBe("localhost");
  });
});

describe("buildDevCommand", () => {
  it("builds cd + bun run dev", () => {
    const cmd = buildDevCommand("/path/to/maw-ui");
    expect(cmd).toContain("cd /path/to/maw-ui");
    expect(cmd).toContain("bun run dev");
  });
});

describe("buildLensUrl", () => {
  it("builds local 2D URL by default", () => {
    const url = buildLensUrl({});
    expect(url).toBe(`http://localhost:${LENS_PORT}/${LENS_PAGE_2D}`);
  });

  it("builds 3D URL with threeD flag", () => {
    const url = buildLensUrl({ threeD: true });
    expect(url).toContain(LENS_PAGE_3D);
  });

  it("appends host param for remote", () => {
    const url = buildLensUrl({ remoteHost: "oracle:3456" });
    expect(url).toContain("?host=oracle%3A3456");
  });

  it("uses custom port", () => {
    const url = buildLensUrl({ port: 9999 });
    expect(url).toContain("localhost:9999");
  });

  it("combines 3D + remote host", () => {
    const url = buildLensUrl({ threeD: true, remoteHost: "neo:3456" });
    expect(url).toContain(LENS_PAGE_3D);
    expect(url).toContain("?host=neo%3A3456");
  });

  it("URL-encodes host parameter", () => {
    const url = buildLensUrl({ remoteHost: "host with spaces" });
    expect(url).toContain("host%20with%20spaces");
  });
});

describe("buildTunnelCommand", () => {
  it("builds SSH command with dual-port forward", () => {
    const cmd = buildTunnelCommand({ user: "neo", host: "oracle.local" });
    expect(cmd).toContain("ssh -N");
    expect(cmd).toContain(`-L ${LENS_PORT}:localhost:${LENS_PORT}`);
    expect(cmd).toContain(`-L ${MAW_PORT}:localhost:${MAW_PORT}`);
    expect(cmd).toContain("neo@oracle.local");
  });

  it("uses provided user", () => {
    const cmd = buildTunnelCommand({ user: "boom", host: "x" });
    expect(cmd).toContain("boom@x");
  });
});

describe("constants", () => {
  it("LENS_PORT is 5173", () => {
    expect(LENS_PORT).toBe(5173);
  });

  it("MAW_PORT is 3456", () => {
    expect(MAW_PORT).toBe(3456);
  });
});
