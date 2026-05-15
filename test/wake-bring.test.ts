import { describe, expect, test } from "bun:test";
import { shouldOfferExistingSessionAttach } from "../src/commands/shared/wake-cmd";

describe("maw bring existing-session behavior", () => {
  test("wake may offer attach for an existing session in an interactive terminal", () => {
    expect(shouldOfferExistingSessionAttach({}, true)).toBe(true);
  });

  test("bring/wake --split never offers the destructive attach prompt", () => {
    expect(shouldOfferExistingSessionAttach({ split: true }, true)).toBe(false);
  });

  test("bring default tab mode never offers the destructive attach prompt", () => {
    expect(shouldOfferExistingSessionAttach({ bring: true }, true)).toBe(false);
  });

  test("explicit attach skips the prompt because attach was already requested", () => {
    expect(shouldOfferExistingSessionAttach({ attach: true }, true)).toBe(false);
  });

  test("headless wake does not prompt", () => {
    expect(shouldOfferExistingSessionAttach({}, false)).toBe(false);
  });
});
