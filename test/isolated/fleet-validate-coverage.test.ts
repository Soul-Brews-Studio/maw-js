import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const existsMock = mock((path: string) => !path.includes("missing-repo"));
const listWindowsMock = mock(async (_session: string) => [
  { name: "registered", index: 0 },
  { name: "stray", index: 1 },
]);
const getGhqRootMock = mock(() => "/ghq");
const loadFleetEntriesMock = mock(() => [
  {
    num: 7,
    groupName: "alpha-group",
    file: "alpha.json",
    session: {
      name: "alpha-session",
      windows: [
        { name: "registered", repo: "Soul-Brews-Studio/present-repo" },
        { name: "shared-oracle", repo: "Soul-Brews-Studio/missing-repo" },
      ],
    },
  },
  {
    num: 7,
    groupName: "beta-group",
    file: "beta.json",
    session: {
      name: "beta-session",
      windows: [
        { name: "shared-oracle", repo: "Soul-Brews-Studio/present-repo" },
      ],
    },
  },
]);
const getSessionNamesMock = mock(async () => ["alpha-session", "orphan-session"]);

mock.module("fs", () => ({
  existsSync: existsMock,
}));

mock.module("../../src/sdk", () => ({
  tmux: {
    listWindows: listWindowsMock,
  },
}));

mock.module("../../src/config/ghq-root", () => ({
  getGhqRoot: getGhqRootMock,
}));

mock.module("../../src/commands/shared/fleet-load", () => ({
  loadFleetEntries: loadFleetEntriesMock,
  getSessionNames: getSessionNamesMock,
}));

const { cmdFleetValidate } = await import("../../src/commands/shared/fleet-validate");

describe("fleet validate coverage", () => {
  const originalLog = console.log;
  const originalError = console.error;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    existsMock.mockClear();
    listWindowsMock.mockClear();
    getGhqRootMock.mockClear();
    loadFleetEntriesMock.mockClear();
    getSessionNamesMock.mockClear();
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test("reports duplicate numbers, duplicate oracles, missing repos, orphan sessions, and unregistered windows", async () => {
    await cmdFleetValidate();

    const output = logs.join("\n");
    expect(output).toContain("Fleet Validation");
    expect(output).toContain("Duplicate #07");
    expect(output).toContain("alpha-group, beta-group");
    expect(output).toContain("Duplicate oracle");
    expect(output).toContain("shared-oracle");
    expect(output).toContain("Missing repo");
    expect(output).toContain("Soul-Brews-Studio/missing-repo");
    expect(output).toContain("Orphan session");
    expect(output).toContain("orphan-session");
    expect(output).toContain("Unregistered window");
    expect(output).toContain("stray");
    expect(output).toContain("5 issue(s) found");

    expect(getGhqRootMock).toHaveBeenCalled();
    expect(existsMock).toHaveBeenCalledWith("/ghq/github.com/Soul-Brews-Studio/missing-repo");
    expect(listWindowsMock).toHaveBeenCalledWith("alpha-session");
    expect(listWindowsMock).not.toHaveBeenCalledWith("beta-session");
    expect(errors).toEqual([]);
  });

  test("prints all-clear when the configured fleet and running tmux windows agree", async () => {
    loadFleetEntriesMock.mockImplementationOnce(() => [
      {
        num: 1,
        groupName: "solo",
        file: "solo.json",
        session: {
          name: "solo-session",
          windows: [{ name: "registered", repo: "Soul-Brews-Studio/present-repo" }],
        },
      },
    ]);
    getSessionNamesMock.mockImplementationOnce(async () => ["solo-session"]);
    listWindowsMock.mockImplementationOnce(async () => [{ name: "registered", index: 0 }]);

    await cmdFleetValidate();

    const output = logs.join("\n");
    expect(output).toContain("Fleet Validation");
    expect(output).toContain("✓ All clear");
    expect(output).not.toContain("issue(s) found");
  });

  test("continues validation when tmux window listing fails for a running configured session", async () => {
    loadFleetEntriesMock.mockImplementationOnce(() => [
      {
        num: 1,
        groupName: "solo",
        file: "solo.json",
        session: {
          name: "solo-session",
          windows: [{ name: "registered", repo: "Soul-Brews-Studio/present-repo" }],
        },
      },
    ]);
    getSessionNamesMock.mockImplementationOnce(async () => ["solo-session"]);
    listWindowsMock.mockImplementationOnce(async () => {
      throw new Error("tmux offline");
    });

    await cmdFleetValidate();

    expect(logs.join("\n")).toContain("✓ All clear");
    expect(errors.join("\n")).toContain("failed to list windows for solo-session");
    expect(errors.join("\n")).toContain("tmux offline");
  });
});
