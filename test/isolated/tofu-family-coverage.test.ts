import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

type PeerRecord = {
  url?: string;
  node?: string | null;
  nickname?: string;
  pubkey?: string;
  pubkeyFirstSeen?: string;
  [key: string]: unknown;
};

type StoreData = { peers: Record<string, PeerRecord> };

type TofuModule = typeof import("../../src/vendor/mpr-plugins/peers/tofu");

function createMemoryStore() {
  return {
    peers: {} as Record<string, PeerRecord>,
    mutateCalls: 0,
    reset() {
      this.peers = {};
      this.mutateCalls = 0;
    },
    mutate(mutator: (data: StoreData) => void) {
      this.mutateCalls += 1;
      mutator({ peers: this.peers });
    },
  };
}

const pairStore = createMemoryStore();
const peersStore = createMemoryStore();

const targets: Array<{
  label: string;
  store: ReturnType<typeof createMemoryStore>;
  load: () => Promise<TofuModule>;
  mod?: TofuModule;
}> = [
  {
    label: "pair/internal",
    store: pairStore,
    load: () => import("../../src/vendor/mpr-plugins/pair/internal/tofu"),
  },
  {
    label: "peers",
    store: peersStore,
    load: () => import("../../src/vendor/mpr-plugins/peers/tofu"),
  },
];

beforeAll(async () => {
  mock.module(
    import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/store.ts"),
    () => ({
      mutatePeers: (mutator: (data: StoreData) => void) => pairStore.mutate(mutator),
    }),
  );

  mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/store.ts"), () => ({
    mutatePeers: (mutator: (data: StoreData) => void) => peersStore.mutate(mutator),
  }));

  for (const target of targets) {
    target.mod = await target.load();
  }
});

for (const target of targets) {
  describe(`${target.label} TOFU policy`, () => {
    const tofu = () => target.mod!;

    beforeEach(() => {
      target.store.reset();
    });

    test("evaluatePeerIdentity covers every TOFU decision kind", () => {
      const freshObserved = tofu().evaluatePeerIdentity(
        "fresh",
        undefined,
        "observed-pubkey-0123456789",
      );
      expect(freshObserved).toMatchObject({
        kind: "tofu-bootstrap",
        alias: "fresh",
        observed: "observed-pubkey-0123456789",
      });
      expect(freshObserved.cached).toBeUndefined();
      expect(freshObserved.message).toContain("first sight");

      const unpinnedObserved = tofu().evaluatePeerIdentity(
        "unpinned",
        { url: "http://unpinned" } as any,
        "observed-after-legacy",
      );
      expect(unpinnedObserved).toMatchObject({
        kind: "tofu-bootstrap",
        alias: "unpinned",
        observed: "observed-after-legacy",
      });

      const emptyCachedObserved = tofu().evaluatePeerIdentity(
        "empty-cache",
        { url: "http://empty", pubkey: "" } as any,
        "observed-after-empty-cache",
      );
      expect(emptyCachedObserved).toMatchObject({
        kind: "tofu-bootstrap",
        alias: "empty-cache",
        observed: "observed-after-empty-cache",
      });

      const legacyFirstContact = tofu().evaluatePeerIdentity("legacy", undefined, undefined);
      expect(legacyFirstContact).toMatchObject({
        kind: "legacy-first-contact",
        alias: "legacy",
      });
      expect(legacyFirstContact.cached).toBeUndefined();
      expect(legacyFirstContact.observed).toBeUndefined();
      expect(legacyFirstContact.message).toContain("legacy peer");

      const legacyAfterPinned = tofu().evaluatePeerIdentity(
        "rollback",
        { url: "http://rollback", pubkey: "cached-pubkey-abcdefghijklmnop" } as any,
        undefined,
      );
      expect(legacyAfterPinned).toMatchObject({
        kind: "legacy-after-pinned",
        alias: "rollback",
        cached: "cached-pubkey-abcdefghijklmnop",
      });
      expect(legacyAfterPinned.observed).toBeUndefined();
      expect(legacyAfterPinned.message).toContain("will hard-fail at v27");

      const match = tofu().evaluatePeerIdentity(
        "stable",
        { url: "http://stable", pubkey: "same-pubkey" } as any,
        "same-pubkey",
      );
      expect(match).toMatchObject({
        kind: "match",
        alias: "stable",
        cached: "same-pubkey",
        observed: "same-pubkey",
      });
      expect(match.message).toContain("pubkey verified");

      const mismatch = tofu().evaluatePeerIdentity(
        "rotated",
        { url: "http://rotated", pubkey: "cached-pubkey-abcdefghijklmnop" } as any,
        "observed-pubkey-qrstuvwxyz",
      );
      expect(mismatch).toMatchObject({
        kind: "mismatch",
        alias: "rotated",
        cached: "cached-pubkey-abcdefghijklmnop",
        observed: "observed-pubkey-qrstuvwxyz",
      });
      expect(mismatch.message).toContain("maw peers forget rotated");
    });

    test("applyTofuDecision bootstraps once and preserves race-safe pins", () => {
      target.store.peers.alice = { url: "http://alice" };

      tofu().applyTofuDecision({
        kind: "tofu-bootstrap",
        alias: "alice",
        observed: "alice-pubkey",
        message: "cache alice",
      });

      expect(target.store.peers.alice.pubkey).toBe("alice-pubkey");
      expect(target.store.peers.alice.pubkeyFirstSeen).toBeString();
      expect(Number.isNaN(Date.parse(target.store.peers.alice.pubkeyFirstSeen!))).toBe(false);

      target.store.peers.alice.pubkeyFirstSeen = "first-write-wins";
      tofu().applyTofuDecision({
        kind: "tofu-bootstrap",
        alias: "alice",
        observed: "racing-pubkey",
        message: "stale bootstrap should not overwrite",
      });
      expect(target.store.peers.alice).toMatchObject({
        pubkey: "alice-pubkey",
        pubkeyFirstSeen: "first-write-wins",
      });

      expect(() =>
        tofu().applyTofuDecision({
          kind: "tofu-bootstrap",
          alias: "forgotten",
          observed: "lost-race-pubkey",
          message: "peer was deleted between evaluate and apply",
        }),
      ).not.toThrow();
      expect(target.store.peers.forgotten).toBeUndefined();
      expect(target.store.mutateCalls).toBe(3);
    });

    test("applyTofuDecision no-ops accepted decisions and throws structured mismatch errors", () => {
      tofu().applyTofuDecision({
        kind: "match",
        alias: "stable",
        cached: "same",
        observed: "same",
        message: "verified",
      });
      tofu().applyTofuDecision({
        kind: "legacy-first-contact",
        alias: "legacy",
        message: "no pubkey yet",
      });
      tofu().applyTofuDecision({
        kind: "legacy-after-pinned",
        alias: "rollback",
        cached: "cached",
        message: "rollback accepted for migration",
      });
      expect(target.store.mutateCalls).toBe(0);

      let thrown: unknown;
      try {
        tofu().applyTofuDecision({
          kind: "mismatch",
          alias: "mallory",
          cached: "cached-pubkey-abcdefghijklmnop",
          observed: "observed-pubkey-qrstuvwxyz",
          message: "rotation refused",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(tofu().PeerPubkeyMismatchError);
      expect(thrown).toMatchObject({
        name: "PeerPubkeyMismatchError",
        alias: "mallory",
        cached: "cached-pubkey-abcdefghijklmnop",
        observed: "observed-pubkey-qrstuvwxyz",
      });
      expect((thrown as Error).message).toContain("maw peers forget mallory");
      expect(target.store.mutateCalls).toBe(0);
    });

    test("tofuRecordPeerIdentity evaluates, applies, returns decisions, and propagates mismatch", () => {
      target.store.peers.carol = { url: "http://carol" };

      const bootstrapped = tofu().tofuRecordPeerIdentity(
        "carol",
        target.store.peers.carol as any,
        "carol-pubkey",
      );
      expect(bootstrapped).toMatchObject({
        kind: "tofu-bootstrap",
        alias: "carol",
        observed: "carol-pubkey",
      });
      expect(target.store.peers.carol.pubkey).toBe("carol-pubkey");

      const matched = tofu().tofuRecordPeerIdentity(
        "carol",
        target.store.peers.carol as any,
        "carol-pubkey",
      );
      expect(matched).toMatchObject({
        kind: "match",
        alias: "carol",
        cached: "carol-pubkey",
        observed: "carol-pubkey",
      });

      expect(() =>
        tofu().tofuRecordPeerIdentity(
          "carol",
          target.store.peers.carol as any,
          "rotated-carol-pubkey",
        ),
      ).toThrow(tofu().PeerPubkeyMismatchError);
    });

    test("forgetPeerPubkey reports not-found, no-pubkey, and cleared while preserving other fields", () => {
      expect(tofu().forgetPeerPubkey("missing")).toBe("not-found");

      target.store.peers.legacy = { url: "http://legacy", nickname: "old-node" };
      expect(tofu().forgetPeerPubkey("legacy")).toBe("no-pubkey");
      expect(target.store.peers.legacy).toEqual({
        url: "http://legacy",
        nickname: "old-node",
      });

      target.store.peers.pinned = {
        url: "http://pinned",
        node: "node",
        pubkey: "pinned-pubkey",
        pubkeyFirstSeen: "2026-05-18T00:00:00.000Z",
        nickname: "keep-me",
      };
      expect(tofu().forgetPeerPubkey("pinned")).toBe("cleared");
      expect(target.store.peers.pinned).toEqual({
        url: "http://pinned",
        node: "node",
        nickname: "keep-me",
      });
    });
  });
}
