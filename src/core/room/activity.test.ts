import { describe, expect, test } from "bun:test";
import { bareName, roomActivity } from "./activity";
import type { RoomArtifact } from "./store";
import type { WorklogEntry } from "../worklog/types";
import type { PresenceRow } from "../presence/route";

const room = (from: string[]): RoomArtifact => ({
  id: "demo", company: "kobo", topic: "t", status: "open", ts: 0, updatedTs: 0,
  messages: from.map((f, i) => ({ id: "m" + i, from: f, text: "x", ts: i })),
});
const wl = (oracle: string, summary: string, ts: number): WorklogEntry =>
  ({ ts, iso: "i" + ts, oracle, kind: "tool" as WorklogEntry["kind"], summary });
const pr = (oracle: string, stale: boolean): PresenceRow =>
  ({ oracle, pane: "%1", model: "opus", model_id: null, remaining_percentage: 42, used_percentage: null, total_input_tokens: null, context_window_size: null, ts: 1, stale });

describe("room activity projection (kobo-242)", () => {
  test("bareName strips host prefix + pane suffix", () => {
    expect(bareName("m5:eq3")).toBe("eq3");
    expect(bareName("eq3.0")).toBe("eq3");
    expect(bareName("m5:conductor.1")).toBe("conductor");
    expect(bareName("web")).toBe("web");
  });

  test("participants = distinct thread `from` minus web, in first-appearance order", () => {
    const out = roomActivity(room(["web", "eq3", "conductor", "eq3", "web"]), [], []);
    expect(out.map((p) => p.oracle)).toEqual(["eq3", "conductor"]); // web dropped, deduped, ordered
  });

  test("joins latest worklog summary + live presence per participant (host/pane-insensitive)", () => {
    const out = roomActivity(
      room(["web", "m5:conductor"]),
      [wl("conductor", "reading store.ts", 1), wl("conductor", "writing route.ts", 2)], // newest wins
      [pr("conductor", false)],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ oracle: "conductor", activity: "writing route.ts", busy: true, stale: false, model: "opus", ctxRemaining: 42 });
  });

  test("no worklog / no presence → nulls + stale (not busy)", () => {
    const out = roomActivity(room(["eq3"]), [], []);
    expect(out[0]).toMatchObject({ oracle: "eq3", activity: null, busy: false, stale: true, model: null });
  });

  test("a stale presence row does not read as busy; a live row beats a stale duplicate", () => {
    const out = roomActivity(room(["eq3"]), [], [pr("eq3", true), pr("eq3", false)]);
    expect(out[0].busy).toBe(true); // live row preferred over the stale one
    const only = roomActivity(room(["eq3"]), [], [pr("eq3", true)]);
    expect(only[0].busy).toBe(false);
  });
});
