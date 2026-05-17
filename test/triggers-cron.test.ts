/**
 * runtime/triggers-cron.ts — pure crontab parser + wouldFireAt dry-run helper.
 *
 * Surface (2 exports, no module-level state, ZERO external imports):
 *   - parseCronField(expr, min, max) → Set<number>
 *   - wouldFireAt(cronExpr, now)     → Date | null (strictly > now, ≤ ~1y)
 *
 * Default-suite coverage: this target has no mock.module seams, no I/O, and no
 * global timers. Keeping it under test/ makes it visible to `test:coverage`:
 *   (1) Capture real fn refs BEFORE mock.module    — nothing imported
 *   (2) Passthrough wrappers use (...args)          — no wrappers needed
 *   (3) os.homedir() caching                        — no fs/os calls
 * Every assertion here exercises real math on Date objects; we pass
 * explicit `now` arguments so no fake timers are installed and no global
 * Date.now state leaks to sibling suites.
 */
import { describe, test, expect } from "bun:test";
import { parseCronField, wouldFireAt } from "../src/core/runtime/triggers-cron";

// ─── parseCronField ─────────────────────────────────────────────────────────

describe("parseCronField()", () => {
  test("'*' expands to the full inclusive range", () => {
    const s = parseCronField("*", 0, 59);
    expect(s.size).toBe(60);
    expect(s.has(0)).toBe(true);
    expect(s.has(59)).toBe(true);
    expect(s.has(30)).toBe(true);
  });

  test("single number → singleton set", () => {
    const s = parseCronField("7", 0, 59);
    expect([...s]).toEqual([7]);
  });

  test("comma list produces each value", () => {
    const s = parseCronField("1,3,5", 0, 59);
    expect([...s].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  test("range 'a-b' is inclusive on both ends", () => {
    const s = parseCronField("2-4", 0, 59);
    expect([...s].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  test("'*/2' over 0-59 yields even minutes only", () => {
    const s = parseCronField("*/2", 0, 59);
    expect(s.size).toBe(30);
    expect(s.has(0)).toBe(true);
    expect(s.has(2)).toBe(true);
    expect(s.has(58)).toBe(true);
    expect(s.has(1)).toBe(false);
    expect(s.has(59)).toBe(false);
  });

  test("range with step '0-10/3' → 0,3,6,9 (stops at or before end)", () => {
    const s = parseCronField("0-10/3", 0, 59);
    expect([...s].sort((a, b) => a - b)).toEqual([0, 3, 6, 9]);
  });

  test("combined list of kinds merges into one set", () => {
    // minute: top of hour, 5 through 7, and every-30 (0,30).
    const s = parseCronField("0,5-7,*/30", 0, 59);
    expect([...s].sort((a, b) => a - b)).toEqual([0, 5, 6, 7, 30]);
  });

  test("step of 1 is identical to no step", () => {
    const plain = [...parseCronField("1-5", 0, 59)].sort((a, b) => a - b);
    const stepped = [...parseCronField("1-5/1", 0, 59)].sort((a, b) => a - b);
    expect(stepped).toEqual(plain);
  });

  test("min == single-value boundary is accepted", () => {
    expect([...parseCronField("1", 1, 31)]).toEqual([1]);
    expect([...parseCronField("31", 1, 31)]).toEqual([31]);
  });

  test("throws when a single value exceeds max", () => {
    expect(() => parseCronField("60", 0, 59)).toThrow(/invalid range/);
  });

  test("throws when a single value is below min", () => {
    expect(() => parseCronField("0", 1, 31)).toThrow(/invalid range/);
  });

  test("throws on reversed range (start > end)", () => {
    expect(() => parseCronField("5-2", 0, 59)).toThrow(/invalid range/);
  });

  test("throws on step of 0", () => {
    expect(() => parseCronField("*/0", 0, 59)).toThrow(/invalid step/);
  });

  test("throws on non-numeric step", () => {
    expect(() => parseCronField("*/abc", 0, 59)).toThrow(/invalid step/);
  });

  test("throws on garbage body (non-numeric, not '*')", () => {
    expect(() => parseCronField("xyz", 0, 59)).toThrow(/invalid range/);
  });
});

// ─── wouldFireAt ────────────────────────────────────────────────────────────

describe("wouldFireAt()", () => {
  test("throws when the expression does not have exactly 5 fields (too few)", () => {
    expect(() => wouldFireAt("* * * *")).toThrow(/must have 5 fields, got 4/);
  });

  test("throws when the expression has 6 fields (no seconds form)", () => {
    expect(() => wouldFireAt("0 * * * * *")).toThrow(/must have 5 fields, got 6/);
  });

  test("surfaces parseCronField errors for invalid sub-expressions", () => {
    expect(() => wouldFireAt("99 * * * *")).toThrow(/invalid range/);
  });

  test("'* * * * *' returns the next minute, strictly after now", () => {
    // 2026-06-01 12:34:17 → next fire at 12:35:00.
    const now = new Date(2026, 5, 1, 12, 34, 17, 500);
    const fire = wouldFireAt("* * * * *", now)!;
    expect(fire).not.toBeNull();
    expect(fire.getTime()).toBeGreaterThan(now.getTime());
    expect(fire.getFullYear()).toBe(2026);
    expect(fire.getMonth()).toBe(5);
    expect(fire.getDate()).toBe(1);
    expect(fire.getHours()).toBe(12);
    expect(fire.getMinutes()).toBe(35);
    // Seconds/ms are always zeroed.
    expect(fire.getSeconds()).toBe(0);
    expect(fire.getMilliseconds()).toBe(0);
  });

  test("same-minute never matches — '* * * * *' at :00.000 still advances to :01", () => {
    // Even with seconds already at 0, wouldFireAt must return strictly after.
    const now = new Date(2026, 0, 1, 9, 10, 0, 0);
    const fire = wouldFireAt("* * * * *", now)!;
    expect(fire.getMinutes()).toBe(11);
    expect(fire.getTime()).toBeGreaterThan(now.getTime());
  });

  test("'30 * * * *' returns the upcoming :30 within the same hour", () => {
    const now = new Date(2026, 2, 15, 8, 15, 0, 0);
    const fire = wouldFireAt("30 * * * *", now)!;
    expect(fire.getHours()).toBe(8);
    expect(fire.getMinutes()).toBe(30);
  });

  test("'30 * * * *' rolls to the next hour when we are already past :30", () => {
    const now = new Date(2026, 2, 15, 8, 45, 0, 0);
    const fire = wouldFireAt("30 * * * *", now)!;
    expect(fire.getHours()).toBe(9);
    expect(fire.getMinutes()).toBe(30);
  });

  test("'0 12 * * *' returns today's noon when called before noon", () => {
    const now = new Date(2026, 2, 15, 9, 0, 0, 0);
    const fire = wouldFireAt("0 12 * * *", now)!;
    expect(fire.getDate()).toBe(15);
    expect(fire.getHours()).toBe(12);
    expect(fire.getMinutes()).toBe(0);
  });

  test("'0 12 * * *' rolls to tomorrow's noon when called after noon", () => {
    const now = new Date(2026, 2, 15, 13, 0, 0, 0);
    const fire = wouldFireAt("0 12 * * *", now)!;
    expect(fire.getDate()).toBe(16);
    expect(fire.getHours()).toBe(12);
    expect(fire.getMinutes()).toBe(0);
  });

  test("'0 0 1 * *' returns the first of next month when mid-month", () => {
    // 2026-03-15 → next fire 2026-04-01 00:00.
    const now = new Date(2026, 2, 15, 10, 0, 0, 0);
    const fire = wouldFireAt("0 0 1 * *", now)!;
    expect(fire.getFullYear()).toBe(2026);
    expect(fire.getMonth()).toBe(3); // April (0-indexed)
    expect(fire.getDate()).toBe(1);
    expect(fire.getHours()).toBe(0);
    expect(fire.getMinutes()).toBe(0);
  });

  test("'0 0 * * 1' fires next Monday at midnight", () => {
    // 2026-04-17 is a Friday (dow=5). Next Monday = 2026-04-20.
    const now = new Date(2026, 3, 17, 12, 0, 0, 0);
    expect(now.getDay()).toBe(5); // sanity
    const fire = wouldFireAt("0 0 * * 1", now)!;
    expect(fire.getDay()).toBe(1); // Monday
    expect(fire.getFullYear()).toBe(2026);
    expect(fire.getMonth()).toBe(3);
    expect(fire.getDate()).toBe(20);
    expect(fire.getHours()).toBe(0);
  });

  test("month field restricts firings and skips non-matching months", () => {
    // '0 0 1 6 *' — only June 1st. From January, the fire must land in June.
    const now = new Date(2026, 0, 10, 0, 0, 0, 0);
    const fire = wouldFireAt("0 0 1 6 *", now)!;
    expect(fire.getMonth()).toBe(5); // June (0-indexed)
    expect(fire.getDate()).toBe(1);
    expect(fire.getFullYear()).toBe(2026);
  });

  test("impossible combo (Feb 30) returns null within the one-year search window", () => {
    // February never has a 30th — the scanner must exhaust its budget and bail.
    const now = new Date(2026, 0, 1, 0, 0, 0, 0);
    expect(wouldFireAt("0 0 30 2 *", now)).toBeNull();
  });

  test("'*/15 * * * *' returns the next quarter-hour", () => {
    // 2026-04-17 08:07 → next fire at 08:15.
    const now = new Date(2026, 3, 17, 8, 7, 0, 0);
    const fire = wouldFireAt("*/15 * * * *", now)!;
    expect(fire.getHours()).toBe(8);
    expect(fire.getMinutes()).toBe(15);
  });

  test("returned Date always has seconds and milliseconds zeroed", () => {
    const now = new Date(2026, 6, 4, 3, 2, 45, 123);
    const fire = wouldFireAt("* * * * *", now)!;
    expect(fire.getSeconds()).toBe(0);
    expect(fire.getMilliseconds()).toBe(0);
  });

  test("defaults `now` to current time when omitted (returns a future Date)", () => {
    // We don't pin a value — just assert the contract: Date, strictly in the future.
    const before = Date.now();
    const fire = wouldFireAt("* * * * *")!;
    expect(fire).toBeInstanceOf(Date);
    expect(fire.getTime()).toBeGreaterThan(before);
  });

  test("tolerates surrounding whitespace in the expression", () => {
    const now = new Date(2026, 2, 15, 8, 15, 0, 0);
    const fire = wouldFireAt("  30 * * * *  ", now)!;
    expect(fire.getMinutes()).toBe(30);
  });
});
