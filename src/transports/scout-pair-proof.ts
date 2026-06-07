import { createHmac, timingSafeEqual } from "crypto";

export interface AutoPairIdentity {
  node: string;
  oracle: string;
  url: string;
  pubkey: string;
}

function canonicalAutoPairIdentity(identity: AutoPairIdentity): string {
  return [
    identity.oracle,
    identity.node,
    identity.url,
    identity.pubkey,
  ].join("\n");
}

export function signAutoPairProof(identity: AutoPairIdentity, federationToken: string): string {
  return createHmac("sha256", federationToken)
    .update(canonicalAutoPairIdentity(identity))
    .digest("hex");
}

export function verifyAutoPairProof(
  identity: AutoPairIdentity,
  federationToken: string,
  proof: string,
): boolean {
  const expected = signAutoPairProof(identity, federationToken);
  if (expected.length !== proof.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(proof, "hex"));
  } catch {
    return false;
  }
}
