import { describe, expect, test } from "bun:test";
import fixtures from "./canonical-session-name.fixtures.json";
import { canonicalSessionName, type CanonicalSessionNameInput } from "../../src/core/fleet/session-name";

describe("portable canonical session name fixtures (#1812)", () => {
  for (const fixture of fixtures as Array<{ name: string; input: CanonicalSessionNameInput; expected: string }>) {
    test(fixture.name, () => {
      expect(canonicalSessionName(fixture.input)).toBe(fixture.expected);
    });
  }
});
