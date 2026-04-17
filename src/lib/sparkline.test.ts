import { describe, it, expect } from "bun:test";
import { sparkline } from "./sparkline";

describe("sparkline()", () => {
  it("happy path — normalizes correctly", () => {
    // values=[0,1,3,7,5,2,0.5], max=7
    // norms: round(0/7*7)=0→▁, round(1/7*7)=1→▂, round(3/7*7)=3→▄,
    //        round(7/7*7)=7→█, round(5/7*7)=5→▆, round(2/7*7)=2→▃, round(0.5/7*7)=1→▂
    const result = sparkline([0, 1, 3, 7, 5, 2, 0.5], Array(7).fill(true));
    expect(result).toBe("▁▂▄█▆▃▂");
    expect(result).toHaveLength(7);
  });

  it("single bucket — renders █ when cost > 0", () => {
    expect(sparkline([2.5], [true])).toBe("█");
  });

  it("all zero cost, all active — renders ▁ (not ░)", () => {
    expect(sparkline([0, 0, 0], [true, true, true])).toBe("▁▁▁");
  });

  it("no activity — renders ░", () => {
    expect(sparkline([0, 0, 0], [false, false, false])).toBe("░░░");
  });

  it("mixed: some days active, some not", () => {
    // day 0: ░ (no sessions), day 1: ░ (no sessions),
    // day 2: max=1.2, norm=round(1.2/1.2*7)=7 → █
    // day 3: active, cost=0, max>0 → norm=0 → ▁
    const result = sparkline([0, 0, 1.2, 0], [false, false, true, true]);
    expect(result).toBe("░░█▁");
  });

  it("large values — normalized correctly, no overflow", () => {
    // max=500: round(100/500*7)=1→▂, round(200/500*7)=3→▄, round(500/500*7)=7→█, round(50/500*7)=1→▂
    const result = sparkline([100, 200, 500, 50], Array(4).fill(true));
    expect(result).toBe("▂▄█▂");
  });

  it("all same non-zero value — flat line at █", () => {
    // max=1, each norm=round(1/1*7)=7 → BLOCKS[8]=█
    expect(sparkline([1, 1, 1], Array(3).fill(true))).toBe("███");
  });

  it("omitted hadActivity defaults to v > 0 detection", () => {
    // v=0 → not active → ░; v=1, v=2 → active
    const r = sparkline([0, 1, 2]);
    expect(r[0]).toBe("░"); // v=0, treated as not active
    expect(r.slice(1)).not.toContain("░");
  });

  it("single-bucket zero cost no activity — ░", () => {
    expect(sparkline([0], [false])).toBe("░");
  });

  it("seven-day all-inactive window — ░░░░░░░", () => {
    expect(sparkline([0, 0, 0, 0, 0, 0, 0], Array(7).fill(false))).toBe("░░░░░░░");
  });
});
