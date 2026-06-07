import { describe, expect, mock, test } from "bun:test";

mock.module("maw-js/config", () => ({
  loadConfig: () => ({
    namedPeers: [
      { name: "clinic", url: "https://clinic.local:4567/" },
    ],
  }),
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFindSync: () => null,
}));

const ui = await import("../../src/vendor/mpr-plugins/ui/impl.ts?ui-impl-next-coverage");

describe("ui impl barrel coverage", () => {
  test("re-exports helper constants and URL builders", () => {
    expect(ui.LENS_PORT).toBe(5173);
    expect(ui.MAW_PORT).toBe(3456);
    expect(ui.LENS_PAGE_2D).toBe("federation_2d.html");
    expect(ui.LENS_PAGE_3D).toBe("federation.html");

    expect(ui.justHost("clinic.local:4567")).toBe("clinic.local");
    expect(ui.buildDevCommand("/tmp/maw-ui")).toBe("cd /tmp/maw-ui && bun run dev");
    expect(ui.buildLensUrl({ threeD: true, remoteHost: "clinic.local:4567" })).toBe(
      "http://localhost:5173/federation.html?host=clinic.local%3A4567",
    );
    expect(ui.buildTunnelCommand({ user: "neo", host: "clinic.local" })).toBe(
      "ssh -N -L 5173:localhost:5173 -L 3456:localhost:3456 neo@clinic.local",
    );
  });

  test("re-exports peer resolution, arg parsing, and rendering", () => {
    expect(ui.resolvePeerHostPort("clinic")).toBe("clinic.local:4567");
    expect(ui.resolvePeerHostPort("example.org:9999")).toBe("example.org:9999");
    expect(ui.resolvePeerHostPort("bad host name")).toBeNull();

    expect(ui.parseUiArgs(["--3d", "clinic"])).toMatchObject({
      peer: "clinic",
      threeD: true,
    });

    expect(ui.renderUiOutput({ peer: "clinic", threeD: true })).toBe(
      "http://localhost:5173/federation.html?host=clinic.local%3A4567",
    );
  });
});
