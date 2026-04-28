/**
 * Tests for hostedAgents from src/commands/shared/federation-identity.ts.
 * Pure function — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { hostedAgents } from "../../src/commands/shared/federation-identity";

describe("hostedAgents", () => {
  it("returns empty for empty agents", () => {
    expect(hostedAgents({}, "white")).toEqual([]);
  });

  it("returns agents matching node name", () => {
    const agents = { neo: "white", pulse: "black", volt: "white" };
    const result = hostedAgents(agents, "white");
    expect(result).toEqual(["neo", "volt"]);
  });

  it("returns agents with 'local' shorthand", () => {
    const agents = { neo: "local", pulse: "black" };
    const result = hostedAgents(agents, "white");
    expect(result).toEqual(["neo"]);
  });

  it("matches both node name and 'local'", () => {
    const agents = { neo: "white", pulse: "local", volt: "black" };
    const result = hostedAgents(agents, "white");
    expect(result).toEqual(["neo", "pulse"]);
  });

  it("returns empty when no agents match", () => {
    const agents = { neo: "black", pulse: "red" };
    expect(hostedAgents(agents, "white")).toEqual([]);
  });

  it("is case-sensitive for node name", () => {
    const agents = { neo: "White" };
    expect(hostedAgents(agents, "white")).toEqual([]);
  });

  it("does not match 'localhost'", () => {
    const agents = { neo: "localhost" };
    expect(hostedAgents(agents, "white")).toEqual([]);
  });

  it("returns all when all are local", () => {
    const agents = { a: "local", b: "local", c: "local" };
    expect(hostedAgents(agents, "any")).toEqual(["a", "b", "c"]);
  });
});
