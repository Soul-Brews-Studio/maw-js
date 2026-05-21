import { describe, expect, test } from "bun:test";
import fixtures from "./bring-to-flag.fixtures.json";
import { translateBringToFlag } from "../../src/commands/shared/bring-flags";

describe("portable bring --to flag translation fixtures (#1816)", () => {
  for (const fixture of fixtures as Array<{ name: string; input: string[]; expected: string[] }>) {
    test(fixture.name, () => {
      expect(translateBringToFlag(fixture.input)).toEqual(fixture.expected);
    });
  }
});
