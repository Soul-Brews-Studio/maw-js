import { describe, expect, test } from "bun:test";
import { signAutoPairProof, verifyAutoPairProof, type AutoPairIdentity } from "../src/transports/scout-pair-proof";

const identity: AutoPairIdentity = {
  node: "m5",
  oracle: "mawjs",
  url: "http://m5.local:3456",
  pubkey: "pub-abc",
};

describe("scout auto-pair proof", () => {
  test("signs stable HMAC proofs over canonical identity fields", () => {
    const proof = signAutoPairProof(identity, "token-a");
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(signAutoPairProof({ ...identity }, "token-a")).toBe(proof);
    expect(signAutoPairProof({ ...identity, node: "other" }, "token-a")).not.toBe(proof);
  });

  test("verifies valid proofs and rejects wrong token, identity, length, and hex", () => {
    const proof = signAutoPairProof(identity, "token-a");
    expect(verifyAutoPairProof(identity, "token-a", proof)).toBe(true);
    expect(verifyAutoPairProof(identity, "token-b", proof)).toBe(false);
    expect(verifyAutoPairProof({ ...identity, pubkey: "pub-other" }, "token-a", proof)).toBe(false);
    expect(verifyAutoPairProof(identity, "token-a", proof.slice(2))).toBe(false);
    expect(verifyAutoPairProof(identity, "token-a", "z".repeat(64))).toBe(false);
  });
});
