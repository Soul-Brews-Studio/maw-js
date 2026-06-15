import { describe, expect, test } from "bun:test";
import { Readable } from "stream";
import { pickOracle, rankOracleCandidates, resolveOracle } from "../src/core/resolve";

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
  test("rankOracleCandidates prefers live sessions then recent activity and stable slug order", () => {
    const candidates = [
      { owner: "arkkra-co", repo: "volt-oracle", path: "/gh/arkkra-co/volt-oracle" },
      { owner: "laris-co", repo: "volt-oracle", path: "/gh/laris-co/volt-oracle" },
      { owner: "soul-brews-studio", repo: "volt-oracle", path: "/gh/soul-brews-studio/volt-oracle" },
    ];
    const now = 12_000_000;
    const before = candidates.map(c => `${c.owner}/${c.repo}`);
    const after = rankOracleCandidates(candidates, {
      liveSessions: new Set(["/gh/laris-co/volt-oracle"]),
      now,
      getLastActivityMs: (path) => {
        if (path.endsWith("arkkra-co/volt-oracle")) return now - 11 * 60 * 60 * 1000;
        if (path.endsWith("laris-co/volt-oracle")) return now - 2 * 60 * 1000;
        return now - 3 * 24 * 60 * 60 * 1000;
      },
    }).map(c => ({
      slug: `${c.owner}/${c.repo}`,
      recommended: c.recommended,
      hasLiveSession: c.hasLiveSession,
      lastActivityMs: c.lastActivityMs,
    }));

    expect(before).toEqual([
      "arkkra-co/volt-oracle",
      "laris-co/volt-oracle",
      "soul-brews-studio/volt-oracle",
    ]);
    expect(after.map(c => c.slug)).toEqual([
      "laris-co/volt-oracle",
      "arkkra-co/volt-oracle",
      "soul-brews-studio/volt-oracle",
    ]);
    expect(after[0]!.slug).toBe("laris-co/volt-oracle");
    expect(after[0]!.recommended).toBe(true);
    expect(after[0]!.hasLiveSession).toBe(true);

    // Deterministic tie-break when activity is equal and no live sessions are present.
    const tieOrdered = rankOracleCandidates(candidates, {
      now,
      getLastActivityMs: () => now - 60_000,
    });
    expect(tieOrdered[0]!.recommended).toBe(true);
    expect(tieOrdered.map(c => `${c.owner}/${c.repo}`)).toEqual([
      "arkkra-co/volt-oracle",
      "laris-co/volt-oracle",
      "soul-brews-studio/volt-oracle",
    ]);
  });

  test("returns selected candidate from injected reader", async () => {
    const writes: string[] = [];
    const selected = await pickOracle([
      { owner: "one", repo: "alpha-oracle" },
      { owner: "two", repo: "alpha-oracle" },
    ], {
      stream: { write: (text: string) => { writes.push(text); return true; } },
      reader: Readable.from(["2\n"]) as NodeJS.ReadStream,
    });

    expect(selected).toMatchObject({ owner: "two", repo: "alpha-oracle" });
    expect(writes.join("")).toContain("Wake which oracle?");
    expect(writes.join("")).toContain("two/alpha-oracle");
  });

  test("defaults to rank #1 on Enter", async () => {
    const selected = await pickOracle([
      { owner: "one", repo: "alpha-oracle", path: "/gh/one/alpha-oracle" },
      { owner: "two", repo: "alpha-oracle", path: "/gh/two/alpha-oracle" },
    ], {
      stream: { write: () => true },
      liveSessions: new Set(["/gh/two/alpha-oracle"]),
      reader: Readable.from(["\n"]) as NodeJS.ReadStream,
    });

    expect(selected).toMatchObject({ owner: "two", repo: "alpha-oracle", path: "/gh/two/alpha-oracle" });
  });

  test("returns null for invalid choices", async () => {
    const selected = await pickOracle([{ owner: "one", repo: "alpha-oracle" }], {
      stream: { write: () => true },
      reader: Readable.from(["9\n"]) as NodeJS.ReadStream,
    });
    expect(selected).toBeNull();
  });
});
