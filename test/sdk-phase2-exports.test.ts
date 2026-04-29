/**
 * @maw-js/sdk Phase 2 widening — smoke test for re-exports.
 *
 * Phase 1 plugin extraction (registry phase 2 work) failed for 30 plugins
 * because their source imports reach into ../../../<core|cli|config|lib>.
 * Audit: /tmp/sdk-widen-audit.md.
 *
 * This test asserts the audited symbols are reachable via "@maw-js/sdk" so
 * extracted plugins can rewrite raw paths to the SDK import. We only assert
 * presence + callable shape — behavior is covered by each module's own tests
 * (config/, matcher/, ghq/, consent/, lib/profile-loader, lib/artifacts).
 */

import { describe, test, expect } from "bun:test";
import * as sdk from "../packages/sdk/index.ts";

describe("@maw-js/sdk Phase 2 widening", () => {
  test("re-exports flag-parsing helpers", () => {
    expect(typeof sdk.parseFlags).toBe("function");
  });

  test("re-exports config helpers", () => {
    expect(typeof sdk.loadConfig).toBe("function");
    expect(typeof sdk.cfgTimeout).toBe("function");
    expect(typeof sdk.buildCommand).toBe("function");
    expect(typeof sdk.buildCommandInDir).toBe("function");
  });

  test("re-exports target-resolution helpers", () => {
    expect(typeof sdk.resolveSessionTarget).toBe("function");
    expect(typeof sdk.resolveWorktreeTarget).toBe("function");
    expect(typeof sdk.normalizeTarget).toBe("function");
  });

  test("re-exports ghq repo-discovery helpers", () => {
    expect(typeof sdk.ghqFind).toBe("function");
    expect(typeof sdk.ghqFindSync).toBe("function");
  });

  test("re-exports consent primitives", () => {
    expect(typeof sdk.listPending).toBe("function");
    expect(typeof sdk.listTrust).toBe("function");
    expect(typeof sdk.recordTrust).toBe("function");
    expect(typeof sdk.removeTrust).toBe("function");
    expect(typeof sdk.approveConsent).toBe("function");
    expect(typeof sdk.rejectConsent).toBe("function");
  });

  test("re-exports terminal helpers", () => {
    expect(typeof sdk.tlink).toBe("function");
  });

  test("re-exports profile-loader helpers", () => {
    expect(typeof sdk.getActiveProfile).toBe("function");
    expect(typeof sdk.loadAllProfiles).toBe("function");
    expect(typeof sdk.loadProfile).toBe("function");
    expect(typeof sdk.setActiveProfile).toBe("function");
  });

  test("re-exports artifact helpers", () => {
    expect(typeof sdk.createArtifact).toBe("function");
    expect(typeof sdk.updateArtifact).toBe("function");
    expect(typeof sdk.writeResult).toBe("function");
    expect(typeof sdk.addAttachment).toBe("function");
    expect(typeof sdk.listArtifacts).toBe("function");
    expect(typeof sdk.getArtifact).toBe("function");
    expect(typeof sdk.artifactDir).toBe("function");
  });

  // Behavior smoke: pure functions are safe to invoke without filesystem state.
  test("normalizeTarget strips trailing /.git/", () => {
    expect(sdk.normalizeTarget("foo/.git/")).toBe("foo");
    expect(sdk.normalizeTarget("foo")).toBe("foo");
    expect(sdk.normalizeTarget("")).toBe("");
  });

  test("resolveSessionTarget exact match wins", () => {
    const items = [{ name: "alpha" }, { name: "beta" }];
    const r = sdk.resolveSessionTarget("alpha", items);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("alpha");
  });

  test("parseFlags returns positional in `_`", () => {
    const r = sdk.parseFlags(["--flag", "value", "pos1", "pos2"], {
      "--flag": String,
    });
    expect(r["--flag"]).toBe("value");
    expect(r._).toEqual(["pos1", "pos2"]);
  });

  test("tlink returns a string for a URL", () => {
    const out = sdk.tlink("https://example.com", "click");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("listArtifacts is callable and returns an array", () => {
    const result = sdk.listArtifacts("__nonexistent_team_for_smoke__");
    expect(Array.isArray(result)).toBe(true);
  });
});
