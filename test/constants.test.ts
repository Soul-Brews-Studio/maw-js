import { describe, test, expect } from "bun:test";
import { roomStyle, agentColor, ROOM_COLORS } from "../office/src/lib/constants";

describe("roomStyle", () => {
  test("returns known room for known session name", () => {
    const style = roomStyle("0");
    expect(style.accent).toBe("#26c6da");
    expect(style.label).toBe("Main");
  });

  test("returns known room for 1-oracles", () => {
    const style = roomStyle("1-oracles");
    expect(style.accent).toBe("#7e57c2");
    expect(style.label).toBe("Oracles");
  });

  test("returns fallback for unknown session", () => {
    const style = roomStyle("unknown-session-xyz");
    expect(style.accent).toBeTruthy();
    expect(style.label).toBe("Room");
  });

  test("is deterministic for same input", () => {
    const a = roomStyle("my-session");
    const b = roomStyle("my-session");
    expect(a).toEqual(b);
  });

  test("all known rooms have required fields", () => {
    for (const [name, room] of Object.entries(ROOM_COLORS)) {
      expect(room.accent).toBeTruthy();
      expect(room.floor).toBeTruthy();
      expect(room.wall).toBeTruthy();
      expect(room.label).toBeTruthy();
    }
  });
});

describe("agentColor", () => {
  test("returns a hex color string", () => {
    const color = agentColor("neo-oracle");
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test("is deterministic", () => {
    expect(agentColor("pulse")).toBe(agentColor("pulse"));
  });

  test("different names can produce different colors", () => {
    const colors = new Set(["neo", "pulse", "hermes", "nexus", "odin", "mother"].map(agentColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});
