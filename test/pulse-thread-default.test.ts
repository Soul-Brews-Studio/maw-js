import { describe, expect, test } from "bun:test";
import {
  addTaskToPeriodComment,
  findOrCreateDailyThread,
  pulseThreadDeps,
  timePeriod,
  todayDate,
  todayLabel,
} from "../src/commands/shared/pulse-thread";

function fixed(iso: string): Date {
  return new Date(iso);
}

function makeDeps(outputs: (string | ((cmd: string) => string))[] = []) {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps = pulseThreadDeps({
    hostExec: async (cmd: string) => {
      calls.push(cmd);
      const output = outputs.shift();
      if (typeof output === "function") return output(cmd);
      return output ?? "";
    },
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    now: () => fixed("2026-05-17T08:09:00.000Z"),
  });
  return { calls, deps, logs };
}

describe("pulse-thread date helpers", () => {
  test("default dependency factory supplies a runtime clock", () => {
    expect(pulseThreadDeps().now()).toBeInstanceOf(Date);
  });

  test("formats stable local dates and Thai day labels with an injected date", () => {
    const sunday = fixed("2026-05-17T01:02:03.000Z");

    expect(todayDate(sunday)).toBe("2026-05-17");
    expect(todayLabel(sunday)).toBe("2026-05-17 (อาทิตย์)");
  });

  test("classifies each period boundary", () => {
    expect(timePeriod(fixed("2026-05-17T00:00:00.000Z"))).toBe("midnight");
    expect(timePeriod(fixed("2026-05-17T05:59:00.000Z"))).toBe("midnight");
    expect(timePeriod(fixed("2026-05-17T06:00:00.000Z"))).toBe("morning");
    expect(timePeriod(fixed("2026-05-17T11:59:00.000Z"))).toBe("morning");
    expect(timePeriod(fixed("2026-05-17T12:00:00.000Z"))).toBe("afternoon");
    expect(timePeriod(fixed("2026-05-17T17:59:00.000Z"))).toBe("afternoon");
    expect(timePeriod(fixed("2026-05-17T18:00:00.000Z"))).toBe("evening");
    expect(timePeriod(fixed("2026-05-17T23:59:00.000Z"))).toBe("evening");
  });
});

describe("findOrCreateDailyThread", () => {
  test("returns an existing daily thread matched by date", async () => {
    const { calls, deps, logs } = makeDeps([
      JSON.stringify([
        {
          number: 42,
          title: "📅 2026-05-17 (อาทิตย์) Daily Thread",
          url: "https://github.com/laris-co/pulse-oracle/issues/42",
        },
      ]),
    ]);

    await expect(findOrCreateDailyThread("laris-co/pulse-oracle", deps)).resolves.toEqual({
      url: "https://github.com/laris-co/pulse-oracle/issues/42",
      num: 42,
      isNew: false,
    });
    expect(calls).toEqual([
      "gh issue list --repo laris-co/pulse-oracle --search '📅 2026-05-17 in:title' --state open --json number,url,title --limit 1",
    ]);
    expect(logs).toEqual([]);
  });

  test("creates a daily thread when no existing title matches today", async () => {
    const { calls, deps, logs } = makeDeps([
      JSON.stringify([{ number: 41, title: "📅 2026-05-16 (เสาร์) Daily Thread", url: "old" }]),
      "https://github.com/laris-co/pulse-oracle/issues/43\n",
    ]);

    await expect(findOrCreateDailyThread("laris-co/pulse-oracle", deps)).resolves.toEqual({
      url: "https://github.com/laris-co/pulse-oracle/issues/43",
      num: 43,
      isNew: true,
    });
    expect(calls[1]).toBe(
      "gh issue create --repo laris-co/pulse-oracle -t '📅 2026-05-17 (อาทิตย์) Daily Thread' -b 'Tasks for 2026-05-17 (อาทิตย์)' -l daily-thread",
    );
    expect(logs.join("\n")).toContain("daily thread #43");
  });

  test("uses issue number 0 when GitHub create output is not a canonical issue URL", async () => {
    const { deps } = makeDeps(["[]", "not-a-url"]);

    await expect(findOrCreateDailyThread("laris-co/pulse-oracle", deps)).resolves.toMatchObject({
      url: "not-a-url",
      num: 0,
      isNew: true,
    });
  });
});

describe("addTaskToPeriodComment", () => {
  test("creates missing period comments and replaces the placeholder for the target period", async () => {
    const { calls, deps } = makeDeps([
      JSON.stringify([{ id: "existing-evening", body: "🌆 Evening (18:00-24:00)\n\n- [ ] old" }]),
      "morning-id",
      "afternoon-id",
      "midnight-id",
      "patched",
    ]);

    await addTaskToPeriodComment(
      "laris-co/pulse-oracle",
      43,
      "morning",
      123,
      "Bob's task",
      "mawjs",
      deps,
    );

    expect(calls[0]).toBe(
      "gh api repos/laris-co/pulse-oracle/issues/43/comments --jq '[.[] | {id: .id, body: .body}]'",
    );
    expect(calls[1]).toContain("gh api repos/laris-co/pulse-oracle/issues/43/comments -f body='🌅 Morning");
    expect(calls[2]).toContain("☀️ Afternoon");
    expect(calls[3]).toContain("🌙 Midnight");
    expect(calls[4]).toBe(
      "gh api repos/laris-co/pulse-oracle/issues/comments/morning-id -X PATCH -f body='🌅 Morning (06:00-12:00)\n\n- [ ] #123 Bob'\\''s task (08:09 → mawjs)'",
    );
  });

  test("appends to an existing target period comment without an oracle tag", async () => {
    const { calls, deps } = makeDeps([
      JSON.stringify([
        { id: "m1", body: "🌅 Morning (06:00-12:00)\n\n- [ ] #1 old" },
        { id: "a1", body: "☀️ Afternoon (12:00-18:00)\n\n_(no tasks yet)_" },
        { id: "e1", body: "🌆 Evening (18:00-24:00)\n\n_(no tasks yet)_" },
        { id: "n1", body: "🌙 Midnight (00:00-06:00)\n\n_(no tasks yet)_" },
      ]),
      "patched",
    ]);

    await addTaskToPeriodComment("laris-co/pulse-oracle", 43, "morning", 124, "append me", undefined, deps);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(
      "gh api repos/laris-co/pulse-oracle/issues/comments/m1 -X PATCH -f body='🌅 Morning (06:00-12:00)\n\n- [ ] #1 old\n- [ ] #124 append me (08:09)'",
    );
  });

  test("returns without patching when the requested period key is unknown", async () => {
    const { calls, deps } = makeDeps(["[]", "m", "a", "e", "n"]);

    await addTaskToPeriodComment("laris-co/pulse-oracle", 43, "dawn", 125, "ignored", undefined, deps);

    expect(calls).toHaveLength(5);
    expect(calls.some((cmd) => cmd.includes("-X PATCH"))).toBe(false);
  });
});
