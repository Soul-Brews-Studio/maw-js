import { describe, expect, test } from "bun:test";
import { D } from "../../../src/config/types";

describe("config defaults", () => {
  test("maxConcurrentAgents defaults to a bounded cap", () => {
    expect(D.limits.maxConcurrentAgents).toBe(40);
  });
});
