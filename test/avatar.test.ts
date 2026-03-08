import { describe, test, expect } from "bun:test";
import { generateAvatar } from "../office/src/lib/avatar";

describe("generateAvatar", () => {
  test("returns all required fields", () => {
    const avatar = generateAvatar("neo-oracle");
    expect(avatar.hairStyle).toBeTruthy();
    expect(avatar.eyeStyle).toBeTruthy();
    expect(avatar.skinColor).toMatch(/^#/);
    expect(avatar.hairColor).toMatch(/^#/);
    expect(avatar.shirtColor).toMatch(/^#/);
  });

  test("is deterministic", () => {
    const a = generateAvatar("pulse-oracle");
    const b = generateAvatar("pulse-oracle");
    expect(a).toEqual(b);
  });

  test("different IDs can produce different avatars", () => {
    const a = generateAvatar("neo-oracle");
    const b = generateAvatar("hermes-oracle");
    // At least one field should differ
    const same = a.hairStyle === b.hairStyle && a.eyeStyle === b.eyeStyle &&
      a.skinColor === b.skinColor && a.hairColor === b.hairColor && a.shirtColor === b.shirtColor;
    expect(same).toBe(false);
  });

  test("hairStyle is valid", () => {
    const valid = ["short", "spiky", "side-part", "curly", "buzz"];
    const avatar = generateAvatar("test-agent");
    expect(valid).toContain(avatar.hairStyle);
  });

  test("eyeStyle is valid", () => {
    const valid = ["dot", "line", "wide"];
    const avatar = generateAvatar("test-agent");
    expect(valid).toContain(avatar.eyeStyle);
  });
});
