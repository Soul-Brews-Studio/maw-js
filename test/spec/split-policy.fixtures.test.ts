import { describe, expect, test } from "bun:test";
import fixtures from "./split-policy.fixtures.json";
import {
  decideSplitPolicy,
  type SplitPolicyDecision,
  type SplitPolicyInput,
} from "../../src/vendor/mpr-plugins/split/impl";

type SplitPolicyFixture = {
  name: string;
  input: SplitPolicyInput;
  expected?: SplitPolicyDecision;
  error?: string;
};

describe("Claude pane split policy fixtures (#1816)", () => {
  for (const fixture of fixtures as SplitPolicyFixture[]) {
    test(fixture.name, () => {
      if (fixture.error) {
        expect(() => decideSplitPolicy(fixture.input)).toThrow(fixture.error);
        return;
      }
      expect(decideSplitPolicy(fixture.input)).toEqual(fixture.expected);
    });
  }
});
