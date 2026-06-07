import { describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";
import { mountViews } from "../../src/views/index";
import { federationView } from "../../src/views/federation";
import { timemachineView } from "../../src/views/timemachine";
import shellHooks from "../../src/plugins/builtin/shell-hooks";

const vendorTeamImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/team/impl");

mock.module(vendorTeamImplPath, () => ({
  cmdTeamShutdown: () => {},
  cmdTeamList: () => {},
  cmdTeamCreate: () => {},
  cmdTeamSpawn: () => {},
  cmdTeamSend: () => {},
  cmdTeamBroadcast: () => {},
  cmdTeamBring: () => {},
  cmdTeamResume: () => {},
  cmdTeamLives: () => {},
}));

describe("absent-from-LCOV simple modules", () => {
  test("mountViews wires the standalone browser views", () => {
    const routes: Array<{ path: string; view: Hono }> = [];
    const app = {
      route(path: string, view: Hono) {
        routes.push({ path, view });
        return app;
      },
    } as unknown as Hono;

    mountViews(app);

    expect(routes.map((route) => route.path)).toEqual([
      "/info",
      "/demo",
      "/timemachine",
      "/federation",
      "/messages",
    ]);
    expect(routes.find((route) => route.path === "/timemachine")?.view).toBe(timemachineView);
    expect(routes.find((route) => route.path === "/federation")?.view).toBe(federationView);
  });

  test("federation and timemachine views return their missing-build guidance", async () => {
    const federation = await federationView.request("/");
    expect(federation.status).toBe(404);
    await expect(federation.text()).resolves.toContain("office/federation.html not found");

    const timemachine = await timemachineView.request("/");
    expect(timemachine.status).toBe(404);
    await expect(timemachine.text()).resolves.toContain("office/timemachine.html not found");
  });

  test("command team impl re-exports the vendor command surface", async () => {
    const teamImpl = await import("../../src/commands/plugins/team/impl.ts?absent-lcov-team-impl");

    expect(typeof teamImpl.cmdTeamCreate).toBe("function");
    expect(typeof teamImpl.cmdTeamList).toBe("function");
    expect(typeof teamImpl.cmdTeamShutdown).toBe("function");
    expect(typeof teamImpl.cmdTeamBring).toBe("function");
    expect(typeof teamImpl.cmdTeamLives).toBe("function");
  });

  test("shell-hooks plugin skips silently when the runtime hooks module is unavailable", () => {
    const hooks = {
      on() {
        throw new Error("shell-hooks should not register without runtime hooks");
      },
    };

    expect(() => shellHooks(hooks as never)).not.toThrow();
  });
});
