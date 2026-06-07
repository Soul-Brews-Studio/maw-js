import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  resolveByName,
  resolveSessionTarget,
  resolveWorktreeTarget,
  type ResolveResult,
} from "../../src/core/matcher/resolve-target";

type Mode = "byName" | "session" | "worktree";
type Named = { name: string };
type Expected = {
  kind: ResolveResult<Named>["kind"];
  match?: string;
  candidates?: string[];
  hints?: string[];
};
type Fixture = {
  name: string;
  mode: Mode;
  input: { target: string; items: string[] };
  expected: Expected;
};

const fixtureUrl = new URL("./matcher-resolve-target.fixtures.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as Fixture[];

function resolveFixture(fixture: Fixture): ResolveResult<Named> {
  const items = fixture.input.items.map(name => ({ name }));
  if (fixture.mode === "session") return resolveSessionTarget(fixture.input.target, items);
  if (fixture.mode === "worktree") return resolveWorktreeTarget(fixture.input.target, items);
  return resolveByName(fixture.input.target, items);
}

function portableShape(result: ResolveResult<Named>): Expected {
  if (result.kind === "exact" || result.kind === "fuzzy") {
    return { kind: result.kind, match: result.match.name };
  }
  if (result.kind === "ambiguous") {
    return { kind: result.kind, candidates: result.candidates.map(item => item.name) };
  }
  const out: Expected = { kind: result.kind };
  if (result.hints) out.hints = result.hints.map(item => item.name);
  return out;
}

describe("portable matcher resolve-target fixtures (#1612)", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(portableShape(resolveFixture(fixture))).toEqual(fixture.expected);
    });
  }
});
