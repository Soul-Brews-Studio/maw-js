import { describe, expect, test } from "bun:test";
import fixtures from "./canonical-node-identity.fixtures.json";
import { canonicalNodeIdentity, type CanonicalNodeIdentityInput } from "../../src/core/fleet/node-identity";

describe("portable canonical node identity fixtures (#1814)", () => {
  for (const fixture of fixtures as Array<{ name: string; input: CanonicalNodeIdentityInput; expected: string }>) {
    test(fixture.name, () => {
      expect(canonicalNodeIdentity(fixture.input)).toBe(fixture.expected);
    });
  }
});
