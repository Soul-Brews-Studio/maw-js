import { describe, expect, test } from "bun:test";
import {
  isDefaultActive1514Plugin,
  isDefaultActive1523Plugin,
  isDefaultActive1524Plugin,
  isDefaultActive1531Plugin,
  isDefaultActive1854Plugin,
  isDefaultActivePlugin,
} from "../src/plugin/default-active";

describe("default-active plugin tier guards", () => {
  test("baseline operator plugins stay active by default", () => {
    for (const name of ["team", "fleet", "panes", "peers", "pair", "tmux", "kill", "plugin", "doctor", "inbox"]) {
      expect(isDefaultActivePlugin(name)).toBe(true);
    }
    expect(isDefaultActivePlugin("dream")).toBe(false);
  });

  test("follow-up migrations expose help-prominent commands", () => {
    expect(isDefaultActive1514Plugin("split")).toBe(true);
    expect(isDefaultActive1523Plugin("shellenv")).toBe(true);
    expect(isDefaultActive1524Plugin("completions")).toBe(true);
    for (const name of ["learn", "find", "talk-to", "project", "workon", "cleanup"]) {
      expect(isDefaultActive1531Plugin(name)).toBe(true);
    }
    expect(isDefaultActive1854Plugin("view")).toBe(true);
    expect(isDefaultActive1531Plugin("fleet")).toBe(false);
    expect(isDefaultActive1854Plugin("split")).toBe(false);
  });
});
