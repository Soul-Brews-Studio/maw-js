import { describe, expect, test } from "bun:test";
import { shouldOfferExistingSessionAttach } from "../src/commands/shared/wake-cmd";

describe("maw bring existing-session behavior", () => {
  test("wake may offer attach for an existing session in an interactive terminal", () => {
    expect(shouldOfferExistingSessionAttach({}, true, {} as NodeJS.ProcessEnv)).toBe(true);
  });

  test("bring/wake --split never offers the destructive attach prompt", () => {
    expect(shouldOfferExistingSessionAttach({ split: true }, true, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("bring default mode never offers the destructive attach prompt", () => {
    expect(shouldOfferExistingSessionAttach({ bring: true }, true, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("explicit attach skips the prompt because attach was already requested", () => {
    expect(shouldOfferExistingSessionAttach({ attach: true }, true, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("headless wake does not prompt", () => {
    expect(shouldOfferExistingSessionAttach({}, false, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("MAW_TEST_MODE disables attach prompts even on interactive terminals", () => {
    expect(shouldOfferExistingSessionAttach({}, true, { MAW_TEST_MODE: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
