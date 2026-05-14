import { describe, test, expect } from "bun:test";
import { annotatePane } from "../../src/commands/core/tmux/impl";

// Pure unit tests for the annotation logic used by `maw tmux ls` (#395).
// No mocks — just deterministic inputs → deterministic outputs.

describe("annotatePane — #395 pure annotation logic", () => {
  const fleet = new Set(["101-mawjs", "112-fusion", "114-mawjs-no2"]);

  test("fleet pane → 'fleet: <stem>' (strips NN- prefix)", () => {
    const p = { id: "%100", target: "101-mawjs:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("fleet: mawjs");
  });

  test("fleet pane with NN prefix stripped even for multi-word stems", () => {
    const p = { id: "%101", target: "114-mawjs-no2:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("fleet: mawjs-no2");
  });

  test("legacy maw-view literal → 'view: maw-view'", () => {
    const p = { id: "%200", target: "maw-view:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("view: maw-view");
  });

  test("per-oracle '*-view' session → 'view: <session>'", () => {
    const p = { id: "%201", target: "mawjs-view:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("view: mawjs-view");
  });

  test("team-agent pane (in team map) → 'team: agent @ team-name'", () => {
    const teamMap = new Map([["%300", "scout @ iter-triage"]]);
    const p = { id: "%300", target: "101-mawjs:0.1", command: "bun" };
    expect(annotatePane(p, fleet, teamMap)).toBe("team: scout @ iter-triage");
  });

  test("team annotation wins over fleet (team is a more-specific view)", () => {
    const teamMap = new Map([["%300", "scout @ iter"]]);
    const p = { id: "%300", target: "101-mawjs:0.1", command: "claude" };
    // Even though session is fleet, the specific pane is a team agent
    expect(annotatePane(p, fleet, teamMap)).toBe("team: scout @ iter");
  });

  test("claude pane in unknown session → 'orphan'", () => {
    const p = { id: "%400", target: "random-session:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("orphan");
  });

  test("bash-running pane → '' (never marked orphan)", () => {
    const p = { id: "%500", target: "random-session:0.0", command: "bash" };
    expect(annotatePane(p, fleet, new Map())).toBe("");
  });

  test("missing command field → '' (not orphan)", () => {
    const p = { id: "%501", target: "random-session:0.0" };
    expect(annotatePane(p, fleet, new Map())).toBe("");
  });

  test("view-prefixed session is NOT a view (suffix-only semantic, safety)", () => {
    const p = { id: "%600", target: "view-foo:0.0", command: "claude" };
    // "view-foo" doesn't match /-view$/ — it's a legit session name.
    // Treated as potential orphan (claude + not fleet/view/team).
    expect(annotatePane(p, fleet, new Map())).toBe("orphan");
  });

  test("empty fleet + empty team + bash → '' (nothing to say)", () => {
    const p = { id: "%700", target: "any:0.0", command: "bash" };
    expect(annotatePane(p, new Set(), new Map())).toBe("");
  });

  test("empty fleet + empty team + claude → 'orphan' (can't verify not-fleet in vacuum)", () => {
    const p = { id: "%701", target: "any:0.0", command: "claude" };
    expect(annotatePane(p, new Set(), new Map())).toBe("orphan");
  });
});
