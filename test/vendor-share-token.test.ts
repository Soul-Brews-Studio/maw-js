import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearShareRegistry,
  createShare,
  verifyShare,
} from "../src/vendor/mpr-plugins/share/impl";

describe("share token auth", () => {
  beforeEach(() => {
    clearShareRegistry();
  });

  test("mint returns sluggable token and verify succeeds for matching token", async () => {
    const share = await createShare({ target: "session:0" });

    expect(share.slug).toMatch(/^[0-9a-z]{10,}$/);
    expect(typeof share.token).toBe("string");
    expect(share.token.length).toBeGreaterThan(0);
    expect(share.url).toContain(share.slug);

    await expect(verifyShare(share.slug, share.token)).resolves.toBe(true);
  });

  test("tampered token fails verification", async () => {
    const share = await createShare({ target: "session:1" });
    await expect(verifyShare(share.slug, `${share.token}-tampered`)).resolves.toBe(false);
  });

  test("expired share fails verification", async () => {
    const share = await createShare({ target: "session:2", ttl: -1 });
    await expect(verifyShare(share.slug, share.token)).resolves.toBe(false);
  });
});
