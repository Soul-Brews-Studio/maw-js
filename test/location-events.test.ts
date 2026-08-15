import { describe, expect, test } from "bun:test";
import {
  buildLocationLifecycleData,
  buildLocationLifecycleFeedEvent,
  isLocationLifecycleData,
  type LocationLifecycleInput,
} from "../src/lib/location-events";

const baseInput: LocationLifecycleInput = {
  id: "loc-1",
  ts: new Date("2026-06-27T12:34:00.000Z"),
  transition: "enter",
  locationId: "bkk",
  placeName: "BKK Airport",
  lat: 13.69,
  lon: 100.75,
  source: "findmy",
  confidence: 0.9,
  device: "Nat iPhone12mini",
  prevEventId: "loc-0",
  dwellMs: 3_600_000,
};

describe("location lifecycle event builders", () => {
  test("buildLocationLifecycleData fills stable fields and optional metadata", () => {
    expect(buildLocationLifecycleData(baseInput)).toEqual({
      id: "loc-1",
      ts: "2026-06-27T12:34:00.000Z",
      transition: "enter",
      locationId: "bkk",
      placeName: "BKK Airport",
      lat: 13.69,
      lon: 100.75,
      source: "findmy",
      confidence: 0.9,
      device: "Nat iPhone12mini",
      prevEventId: "loc-0",
      dwellMs: 3_600_000,
    });
  });

  test("buildLocationLifecycleData normalizes timestamps and mints an id", () => {
    const data = buildLocationLifecycleData({ ...baseInput, id: undefined, ts: 1_700_000_000_000 });
    expect(data.id).toBeTruthy();
    expect(data.ts).toBe("2023-11-14T22:13:20.000Z");
  });

  test("buildLocationLifecycleData defaults blank/invalid timestamps to now", () => {
    const before = Date.now();
    const data = buildLocationLifecycleData({ ...baseInput, ts: "not-a-date" });
    const after = Date.now();
    expect(new Date(data.ts).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(data.ts).getTime()).toBeLessThanOrEqual(after + 5);
  });

  test("buildLocationLifecycleData omits undefined optional fields", () => {
    const data = buildLocationLifecycleData({
      ...baseInput,
      lat: undefined,
      lon: undefined,
      confidence: undefined,
      prevEventId: undefined,
      dwellMs: undefined,
    });
    expect(data.lat).toBeUndefined();
    expect(data.lon).toBeUndefined();
    expect(data.confidence).toBeUndefined();
    expect(data.prevEventId).toBeUndefined();
    expect(data.dwellMs).toBeUndefined();
  });

  test("buildLocationLifecycleFeedEvent derives event type from transition", () => {
    const enter = buildLocationLifecycleFeedEvent(baseInput);
    expect(enter.event).toBe("LocationEnter");
    expect(enter.oracle).toBe("timekeeper");
    expect(enter.sessionId).toBe("bkk");
    expect(enter.message).toContain("enter");
    expect(enter.message).toContain("BKK Airport");
    expect(enter.message).toContain("dwell=3600s");
    expect(enter.message).toContain("conf=0.9");

    expect(buildLocationLifecycleFeedEvent({ ...baseInput, transition: "exit" }).event).toBe("LocationExit");
    expect(buildLocationLifecycleFeedEvent({ ...baseInput, transition: "still" }).event).toBe("LocationStillHere");
  });

  test("buildLocationLifecycleFeedEvent falls back ts to now on invalid timestamp", () => {
    const before = Date.now();
    const event = buildLocationLifecycleFeedEvent({ ...baseInput, ts: "not-a-date" });
    const after = Date.now();
    expect(event.ts).toBeGreaterThanOrEqual(before);
    expect(event.ts).toBeLessThanOrEqual(after + 5);
  });

  test("isLocationLifecycleData accepts complete payloads and rejects malformed values", () => {
    const data = buildLocationLifecycleData(baseInput);
    expect(isLocationLifecycleData(data)).toBe(true);
    expect(isLocationLifecycleData(null)).toBe(false);
    expect(isLocationLifecycleData("nope")).toBe(false);
    expect(isLocationLifecycleData({ ...data, id: 123 })).toBe(false);
    expect(isLocationLifecycleData({ ...data, transition: "sideways" })).toBe(false);
    expect(isLocationLifecycleData({ ...data, locationId: 7 })).toBe(false);
    expect(isLocationLifecycleData({ ...data, source: 7 })).toBe(false);
    expect(isLocationLifecycleData({ ...data, device: 7 })).toBe(false);
  });
});
