import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearShareRegistry,
  createShare,
  getShare,
  revoke,
  sweepExpiredShares,
} from "../src/vendor/mpr-plugins/share/impl";

const originalNow = Date.now;

beforeEach(() => {
  clearShareRegistry();
});

afterEach(() => {
  Date.now = originalNow;
});

describe("share registry", () => {
  test("create and get share entries", async () => {
    const share = await createShare({ target: "alpha", ttl: 120, readOnly: false });
    const loaded = getShare(share.slug);

    expect(loaded).toMatchObject({
      target: "alpha",
      panes: [],
      readOnly: false,
      auth: "token",
    });
  });

  test("sweep removes only expired entries", async () => {
    const alive = await createShare({ target: "alive", ttl: 120 });
    const expired = await createShare({ target: "dead", ttl: 1 });

    expect(getShare(alive.slug)).toBeDefined();
    expect(getShare(expired.slug)).toBeDefined();
    expect(sweepExpiredShares()).toBe(0);

    Date.now = () => originalNow() + 100_000;

    const removed = sweepExpiredShares();
    Date.now = originalNow;

    expect(removed).toBe(1);
    expect(getShare(expired.slug)).toBeUndefined();
    expect(getShare(alive.slug)).toBeDefined();
  });

  test("revoke removes share immediately", async () => {
    const share = await createShare({ target: "revoke" });
    expect(getShare(share.slug)).toBeDefined();
    expect(revoke(share.slug)).toBe(true);
    expect(revoke(share.slug)).toBe(false);
    expect(getShare(share.slug)).toBeUndefined();
  });
});
