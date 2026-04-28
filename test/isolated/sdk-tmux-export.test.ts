/**
 * sdk-tmux-export.test.ts — #855
 *
 * Verifies @maw-js/sdk re-exports `tmux` at the top level so plugins can
 *
 *   import { tmux } from "@maw-js/sdk";
 *   const sessions = await tmux.listSessions();
 *
 * Background: the doc comment at src/core/runtime/sdk.ts:10 originally
 * advertised `maw.tmux.*` but the runtime `maw` const at line 153 never
 * wired tmux. The internal SDK barrel (src/sdk/index.ts) exposed tmux but
 * the public package barrel (packages/sdk/index.ts) didn't. Option 2
 * (chosen): re-export `tmux` from packages/sdk/index.ts as a top-level
 * symbol — cleanest abstraction, no `maw.tmux` aliasing.
 *
 * Strategy:
 *   1. Direct import from packages/sdk/index.ts to assert runtime exports
 *      and shape (the .ts file is what the workspace `@maw-js/sdk`
 *      package resolves to — same path plugin authors hit at install time).
 *   2. .d.ts shape check — no parent-relative imports, declares the new
 *      `tmux` const + `Tmux` class + Tmux* types. Mirrors the existing
 *      test/sdk-package.test.ts contract.
 *
 * Why isolated: runs in its own bun process so mock pollution from other
 * test files (which monkey-patch tmux/ssh transports) cannot leak into
 * the assertions on the real Tmux class. Same convention as the rest of
 * test/isolated/.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { tmux, Tmux } from "../../packages/sdk";

const INDEX_DTS = resolve(__dirname, "..", "..", "packages", "sdk", "index.d.ts");

describe("@maw-js/sdk top-level tmux export (#855)", () => {
  test("tmux is importable from @maw-js/sdk", () => {
    expect(tmux).toBeDefined();
    expect(tmux).not.toBeNull();
  });

  test("tmux is an instance of Tmux", () => {
    expect(tmux).toBeInstanceOf(Tmux);
  });

  test("Tmux is a constructable class", () => {
    const inst = new Tmux();
    expect(inst).toBeInstanceOf(Tmux);
  });

  test("tmux exposes the documented operation methods", () => {
    // Spec from src/core/runtime/sdk.ts:10 — "tmux.* — tmux operations
    // (list, send, capture)". These are the contract surface plugin
    // authors rely on; the rest of the Tmux class is implementation
    // detail we don't lock into the public typing.
    expect(typeof tmux.listSessions).toBe("function");
    expect(typeof tmux.listWindows).toBe("function");
    expect(typeof tmux.listPanes).toBe("function");
    expect(typeof tmux.sendKeys).toBe("function");
    expect(typeof tmux.sendText).toBe("function");
    expect(typeof tmux.capture).toBe("function");
  });

  test("tmux exposes lifecycle helpers (hasSession, kill*, newWindow)", () => {
    expect(typeof tmux.hasSession).toBe("function");
    expect(typeof tmux.killSession).toBe("function");
    expect(typeof tmux.killWindow).toBe("function");
    expect(typeof tmux.killPane).toBe("function");
    expect(typeof tmux.newWindow).toBe("function");
  });

  test("Tmux constructor accepts optional host + socket", () => {
    // Sanity-check the class shape — a custom socket should not throw at
    // construction time. The actual tmux call only happens on method use.
    expect(() => new Tmux(undefined, "/tmp/maw-test.sock")).not.toThrow();
    expect(() => new Tmux("user@host", "/tmp/maw-test.sock")).not.toThrow();
  });
});

describe("@maw-js/sdk index.d.ts surface (#855)", () => {
  const dts = readFileSync(INDEX_DTS, "utf8");

  test(".d.ts is self-contained — no parent-relative imports", () => {
    // Same contract as test/sdk-package.test.ts: must survive file:/tarball
    // installs from outside the repo.
    expect(dts).not.toMatch(/from ["']\.\.\//);
  });

  test(".d.ts declares the new #855 surface (tmux const + Tmux class)", () => {
    expect(dts).toMatch(/export declare const tmux/);
    expect(dts).toMatch(/export declare class Tmux/);
  });

  test(".d.ts declares the Tmux* types plugins need", () => {
    expect(dts).toMatch(/export interface TmuxPane/);
    expect(dts).toMatch(/export interface TmuxWindow/);
    expect(dts).toMatch(/export interface TmuxSession/);
  });

  test(".d.ts retains the pre-existing maw + Identity surface", () => {
    expect(dts).toMatch(/export declare const maw/);
    expect(dts).toMatch(/export interface Identity/);
  });
});
