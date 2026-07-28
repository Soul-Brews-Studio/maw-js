import { describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";
import { mountViews } from "../../src/views/index";
import { federationView } from "../../src/views/federation";
import { timemachineView } from "../../src/views/timemachine";
import shellHooks from "../../src/plugins/builtin/shell-hooks";

const vendorTeamImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/team/impl");
const teamImplPath = import.meta.resolve("../../src/commands/plugins/team/impl.ts?absent-lcov-team-impl");

const mockTeamImpl = {
  cmdTeamShutdown: () => {},
  cmdTeamList: () => {},
  cmdTeamCreate: () => {},
  cmdTeamSpawn: () => {},
  cmdTeamPrune: () => {},
  cmdTeamSend: () => {},
  cmdTeamBroadcast: () => {},
  cmdTeamBring: () => {},
  cmdTeamResume: () => {},
  cmdTeamLives: () => {},
};

mock.module(vendorTeamImplPath, () => ({
  ...mockTeamImpl,
}));

mock.module(teamImplPath, () => mockTeamImpl);

describe("absent-from-LCOV simple modules", { timeout: 30000 }, () => {
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
      "/company",
      "/company-status", // kobo-445 — read-only per-oracle rollup (separate from the kanban board)
      "/room", // kobo-245 — Brainstorm Room core wire
      "/assets", // kobo-398 — same-origin static assets (mermaid.js)
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
    const teamImpl = await import(teamImplPath);

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
