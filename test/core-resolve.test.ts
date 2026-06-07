import { describe, expect, test } from "bun:test";
import { Readable } from "stream";
import { pickOracle, resolveOracle } from "../src/core/resolve";

const repos = [
  "/opt/Code/github.com/Soul-Brews-Studio/mother-oracle",
  "/opt/Code/github.com/Soul-Brews-Studio/mother-roots-oracle",
  "/opt/Code/github.com/laris-co/mother-oracle",
  "/opt/Code/github.com/Soul-Brews-Studio/random-repo",
];

describe("core resolveOracle", () => {
  test("exact bare names stay ambiguous across owners; pwdHint only ranks", async () => {
    const result = await resolveOracle("mother", {
      nameSpace: "oracle",
      matchPolicy: "exact",
      pwdHint: { owner: "Soul-Brews-Studio", repo: "mother-oracle" },
      repos,
    });

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.candidates.map(c => `${c.owner}/${c.repo}`)).toEqual([
      "Soul-Brews-Studio/mother-oracle",
      "laris-co/mother-oracle",
    ]);
  });

  test("owner/repo input is explicit disambiguation", async () => {
    await expect(resolveOracle("laris-co/mother-oracle", {
      nameSpace: "oracle",
      matchPolicy: "exact",
      repos,
    })).resolves.toEqual({
      kind: "exact",
      oracle: {
        owner: "laris-co",
        repo: "mother-oracle",
        path: "/opt/Code/github.com/laris-co/mother-oracle",
      },
    });
  });

  test("prefix and substring policies are opt-in", async () => {
    const prefix = await resolveOracle("mother-r", { nameSpace: "oracle", matchPolicy: "prefix", repos });
    expect(prefix).toMatchObject({ kind: "exact", oracle: { repo: "mother-roots-oracle" } });

    const substring = await resolveOracle("roots", { nameSpace: "oracle", matchPolicy: "substring", repos });
    expect(substring).toMatchObject({ kind: "exact", oracle: { repo: "mother-roots-oracle" } });
  });

  test("non-oracle repos are ignored", async () => {
    await expect(resolveOracle("random", { nameSpace: "oracle", matchPolicy: "substring", repos }))
      .resolves.toEqual({ kind: "not-found" });
  });
});

describe("pickOracle", () => {
  test("returns selected candidate from injected reader", async () => {
    const writes: string[] = [];
    const selected = await pickOracle([
      { owner: "one", repo: "alpha-oracle" },
      { owner: "two", repo: "alpha-oracle" },
    ], {
      stream: { write: (text: string) => { writes.push(text); return true; } },
      reader: Readable.from(["2\n"]) as NodeJS.ReadStream,
    });

    expect(selected).toEqual({ owner: "two", repo: "alpha-oracle" });
    expect(writes.join("")).toContain("Wake which oracle?");
    expect(writes.join("")).toContain("two/alpha-oracle");
  });

  test("returns null for invalid choices", async () => {
    const selected = await pickOracle([{ owner: "one", repo: "alpha-oracle" }], {
      stream: { write: () => true },
      reader: Readable.from(["9\n"]) as NodeJS.ReadStream,
    });
    expect(selected).toBeNull();
  });
});
