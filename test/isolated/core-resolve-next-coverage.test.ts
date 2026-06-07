import { describe, expect, mock, test } from "bun:test";
import { Readable } from "stream";
import { _test, pickOracle, resolveOracle } from "../../src/core/resolve";

describe("core resolve next coverage", () => {
  test("exposes path and intent helpers for oracle refs", () => {
    expect(_test.repoNameFromPath("/opt/Code/github.com/Soul-Brews-Studio/neo-oracle/")).toBe("neo-oracle");
    expect(_test.oracleRefFromPath("C:\\gh\\Soul-Brews-Studio\\Neo-Oracle")).toEqual({
      owner: "Soul-Brews-Studio",
      repo: "Neo-Oracle",
      path: "C:\\gh\\Soul-Brews-Studio\\Neo-Oracle",
    });
    expect(_test.oracleRefFromPath("/tmp/random-repo")).toBeNull();
    expect(_test.normalizedIntentNames("54-Neo-Oracle")).toEqual([
      "54-neo-oracle",
      "54-neo",
      "neo-oracle",
      "neo",
    ]);
    expect(_test.refSlug({ owner: "Soul-Brews-Studio", repo: "neo-oracle" })).toBe("Soul-Brews-Studio/neo-oracle");
  });

  test("session namespace short-circuits and async repo providers are deduped case-insensitively", async () => {
    let loadCalls = 0;
    const repos = async () => {
      loadCalls += 1;
      return [
        "/gh/Soul-Brews-Studio/neo-oracle",
        "/gh/Soul-Brews-Studio/neo-oracle",
        "/gh/other/neo-oracle",
      ];
    };

    await expect(resolveOracle("neo", {
      nameSpace: "session",
      matchPolicy: "exact",
      repos,
    })).resolves.toEqual({ kind: "not-found" });
    expect(loadCalls).toBe(0);

    const result = await resolveOracle("neo", {
      nameSpace: "oracle",
      matchPolicy: "exact",
      pwdHint: { owner: "Soul-Brews-Studio", repo: "neo-oracle" },
      repos,
    });

    expect(loadCalls).toBe(1);
    expect(result).toEqual({
      kind: "ambiguous",
      candidates: [
        { owner: "Soul-Brews-Studio", repo: "neo-oracle", path: "/gh/Soul-Brews-Studio/neo-oracle" },
        { owner: "other", repo: "neo-oracle", path: "/gh/other/neo-oracle" },
      ],
    });
  });

  test("owner-qualified prefix and substring policies keep owner scope and reject malformed input", async () => {
    const repos = [
      "/gh/soul/neo-oracle",
      "/gh/soul/homekeeper-oracle",
      "/gh/other/neo-oracle",
    ];

    await expect(resolveOracle("soul/", {
      nameSpace: "oracle",
      matchPolicy: "substring",
      repos,
    })).resolves.toEqual({ kind: "not-found" });

    await expect(resolveOracle("soul/neo", {
      nameSpace: "oracle",
      matchPolicy: "prefix",
      repos,
    })).resolves.toEqual({
      kind: "exact",
      oracle: { owner: "soul", repo: "neo-oracle", path: "/gh/soul/neo-oracle" },
    });

    await expect(resolveOracle("soul/keeper", {
      nameSpace: "oracle",
      matchPolicy: "substring",
      repos,
    })).resolves.toEqual({
      kind: "exact",
      oracle: { owner: "soul", repo: "homekeeper-oracle", path: "/gh/soul/homekeeper-oracle" },
    });
  });

  test("exact owner-qualified queries normalize missing oracle suffix and pick invalid choices as null", async () => {
    await expect(resolveOracle("soul/neo", {
      nameSpace: "any",
      matchPolicy: "exact",
      repos: ["/gh/soul/neo-oracle", "/gh/soul/neo-tools"],
    })).resolves.toEqual({
      kind: "exact",
      oracle: { owner: "soul", repo: "neo-oracle", path: "/gh/soul/neo-oracle" },
    });

    await expect(resolveOracle("other/neo", {
      nameSpace: "any",
      matchPolicy: "prefix",
      repos: ["/gh/soul/neo-oracle"],
    })).resolves.toEqual({ kind: "not-found" });

    await expect(pickOracle([{ owner: "one", repo: "neo-oracle" }], {
      stream: { write: () => true },
      reader: Readable.from(["9\n"]) as NodeJS.ReadStream,
    })).resolves.toBeNull();
  });

  test("empty queries miss without matching otherwise valid oracle repos", async () => {
    await expect(resolveOracle("   ", {
      nameSpace: "any",
      matchPolicy: "substring",
      repos: ["/gh/soul/neo-oracle"],
    })).resolves.toEqual({ kind: "not-found" });
  });

  test("pickOracle renders path suffixes, accepts readers that end without newline, and handles empty lists", async () => {
    const writes: string[] = [];
    const selected = await pickOracle([
      { owner: "one", repo: "neo-oracle", path: "/gh/one/neo-oracle" },
    ], {
      stream: { write: (text: string) => { writes.push(text); return true; } },
      reader: Readable.from(["1"]) as NodeJS.ReadStream,
    });

    expect(selected).toEqual({ owner: "one", repo: "neo-oracle", path: "/gh/one/neo-oracle" });
    expect(writes.join("")).toContain("/gh/one/neo-oracle");

    await expect(pickOracle([], {
      stream: { write: () => { throw new Error("should not write for empty list"); } },
      reader: Readable.from(["1"]) as NodeJS.ReadStream,
    })).resolves.toBeNull();
  });

  test("pickOracle returns null when tty reading fails", async () => {
    mock.module("fs", () => ({
      openSync: () => { throw new Error("no tty"); },
      readSync: () => 0,
      closeSync: () => undefined,
    }));

    await expect(pickOracle([{ owner: "one", repo: "neo-oracle" }], {
      stream: { write: () => true },
    })).resolves.toBeNull();
  });
});
