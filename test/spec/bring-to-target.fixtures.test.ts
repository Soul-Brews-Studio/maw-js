import { describe, expect, test } from "bun:test";
import fixtures from "./bring-to-target.fixtures.json";
import { parseBringToTarget } from "../../src/commands/shared/bring-flags";

describe("portable bring --to destination parse fixtures (#1816)", () => {
  for (const fixture of fixtures as Array<{ name: string; input: string; expectedSession: string; expectedWindow?: string }>) {
    test(fixture.name, () => {
      expect(parseBringToTarget(fixture.input)).toEqual({
        session: fixture.expectedSession,
        ...(fixture.expectedWindow ? { window: fixture.expectedWindow } : {}),
      });
    });
  }
});
