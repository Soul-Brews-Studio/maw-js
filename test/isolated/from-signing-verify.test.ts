/**
 * from-signing-verify.test.ts — #804 Step 4 VERIFY.
 *
 * Validates the receive-side O6 enforcement for the per-peer "from:" +
 * signature layer added in src/lib/federation-auth.ts (verifyRequest).
 *
 * Wire format mirrored exactly from signRequest() (Step 4 SIGN):
 *   headers: x-maw-from / x-maw-signed-at (ISO 8601) / x-maw-signature
 *   payload: `<from>\n<signedAt>\n<METHOD>\n<path>\n<bodyHashHex>`
 *   crypto:  HMAC-SHA256(peerKey, payload), lowercase hex
 *
 * O6 truth table (docs/federation/0001-peer-identity.md):
 *
 *   | Cached pubkey? | Sender signed? | Outcome
 *   | no             | no             | accept (legacy TOFU bootstrap)
 *   | no             | yes            | accept (TOFU record-only — alpha)
 *   | yes            | no             | REFUSE ("you used to sign")
 *   | yes            | yes valid      | accept
 *   | yes            | yes mismatch   | REFUSE + alert
 *
 * Plus clock-skew rejection: |signed_at - now| > 300s ⇒ refuse.
 *
 * Isolated because we exercise the verify primitive end-to-end. No filesystem
 * state is needed — `lookupPubkey` is injected by the test, not loaded from
 * peers.json.
 */
import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";
import {
  buildFromSignPayload,
  hashBody,
  verifyHmacSig,
  verifyRequest,
  isRefuseDecision,
  type FromPubkeyLookup,
} from "../../src/lib/federation-auth";

// --- Test helpers ----------------------------------------------------------

/** Sign a payload exactly as signRequest does (mirror, not import — keep
 *  the verifier independently exercised even if SIGN ever drifts). */
function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Random 64-char hex secret — what getPeerKey() produces. */
function randomKey(seed: string): string {
  return createHmac("sha256", seed).update("seed").digest("hex");
}

// --- Tests -----------------------------------------------------------------

describe("verifyRequest — O6 truth table (#804 Step 4)", () => {
  const FROM = "mawjs:white";
  const METHOD = "POST";
  const PATH = "/api/send";
  const BODY = JSON.stringify({ target: "mawjs:m5", text: "hello" });

  test("O6 row 1: no cache + unsigned → accept (legacy TOFU bootstrap)", () => {
    const lookup: FromPubkeyLookup = () => undefined;
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {}, // no x-maw-* headers
      body: BODY,
      lookupPubkey: lookup,
    });
    expect(decision.kind).toBe("accept-legacy");
    expect(isRefuseDecision(decision)).toBe(false);
  });

  test("O6 row 2: no cache + signed → accept (TOFU record-only)", () => {
    const senderKey = randomKey("sender-2");
    const ts = nowIso();
    const payload = buildFromSignPayload(FROM, ts, METHOD, PATH, hashBody(BODY));
    const sig = hmacHex(senderKey, payload);
    // No cached pubkey for this peer — alpha-cycle behavior accepts.
    const lookup: FromPubkeyLookup = () => undefined;
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": ts,
      },
      body: BODY,
      lookupPubkey: lookup,
    });
    expect(decision.kind).toBe("accept-tofu-record");
    if (decision.kind === "accept-tofu-record") {
      expect(decision.from).toBe(FROM);
    }
  });

  test("O6 row 3: cached + unsigned → REFUSE (you used to sign)", () => {
    const cached = randomKey("cached-3");
    const lookup: FromPubkeyLookup = (from) => (from === FROM ? cached : undefined);
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      // x-maw-from present but no signature/signed-at — the receiver knows
      // this peer (cache hit) and previously signed. Refuse.
      headers: { "x-maw-from": FROM },
      body: BODY,
      lookupPubkey: lookup,
    });
    expect(decision.kind).toBe("refuse-unsigned");
    expect(isRefuseDecision(decision)).toBe(true);
  });

  test("O6 row 4: cached + signed valid → accept", () => {
    const secret = randomKey("paired-4");
    // Both sender and receiver hold the same secret (HMAC scheme).
    const lookup: FromPubkeyLookup = (from) => (from === FROM ? secret : undefined);
    const ts = nowIso();
    const payload = buildFromSignPayload(FROM, ts, METHOD, PATH, hashBody(BODY));
    const sig = hmacHex(secret, payload);
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": ts,
      },
      body: BODY,
      lookupPubkey: lookup,
    });
    expect(decision.kind).toBe("accept-verified");
    if (decision.kind === "accept-verified") {
      expect(decision.from).toBe(FROM);
    }
  });

  test("O6 row 5: cached + signed mismatch → REFUSE + alert", () => {
    // Cache pins one secret; sender signs with a different one. Refuse.
    const cached = randomKey("cached-5");
    const evil = randomKey("evil-5");
    const lookup: FromPubkeyLookup = (from) => (from === FROM ? cached : undefined);
    const ts = nowIso();
    const payload = buildFromSignPayload(FROM, ts, METHOD, PATH, hashBody(BODY));
    const sig = hmacHex(evil, payload); // wrong secret
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": ts,
      },
      body: BODY,
      lookupPubkey: lookup,
    });
    expect(decision.kind).toBe("refuse-mismatch");
    if (decision.kind === "refuse-mismatch") {
      expect(decision.from).toBe(FROM);
    }
  });
});

describe("verifyRequest — clock skew (#804 Step 4)", () => {
  const FROM = "mawjs:white";
  const METHOD = "POST";
  const PATH = "/api/send";
  const BODY = "";

  test("rejects signed_at older than 300s — refuse-skew", () => {
    const secret = randomKey("skew-past");
    const lookup: FromPubkeyLookup = () => secret;
    const now = nowSec();
    const stale = now - 301; // just past the window
    const staleIso = new Date(stale * 1000).toISOString();
    const payload = buildFromSignPayload(FROM, staleIso, METHOD, PATH, hashBody(BODY));
    const sig = hmacHex(secret, payload);
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": staleIso,
      },
      body: BODY,
      lookupPubkey: lookup,
      now,
    });
    expect(decision.kind).toBe("refuse-skew");
    if (decision.kind === "refuse-skew") {
      expect(decision.delta).toBeGreaterThan(300);
    }
  });

  test("rejects signed_at far in the future — refuse-skew (symmetric)", () => {
    const secret = randomKey("skew-future");
    const lookup: FromPubkeyLookup = () => secret;
    const now = nowSec();
    const futured = now + 3600; // 1 hour ahead
    const iso = new Date(futured * 1000).toISOString();
    const payload = buildFromSignPayload(FROM, iso, METHOD, PATH, hashBody(BODY));
    const sig = hmacHex(secret, payload);
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": iso,
      },
      body: BODY,
      lookupPubkey: lookup,
      now,
    });
    expect(decision.kind).toBe("refuse-skew");
  });

  test("accepts signed_at within ±300s window", () => {
    const secret = randomKey("skew-ok");
    const lookup: FromPubkeyLookup = () => secret;
    const now = nowSec();
    const ts = now - 250; // within window
    const iso = new Date(ts * 1000).toISOString();
    const payload = buildFromSignPayload(FROM, iso, METHOD, PATH, hashBody(BODY));
    const sig = hmacHex(secret, payload);
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": iso,
      },
      body: BODY,
      lookupPubkey: lookup,
      now,
    });
    expect(decision.kind).toBe("accept-verified");
  });
});

describe("verifyRequest — body binding & malformed inputs", () => {
  const FROM = "mawjs:white";
  const METHOD = "POST";
  const PATH = "/api/send";

  test("body-swap (same signature, different body) → refuse-mismatch", () => {
    const secret = randomKey("body-bind");
    const lookup: FromPubkeyLookup = () => secret;
    const ts = nowIso();
    const goodBody = JSON.stringify({ target: "x", text: "ok" });
    const evilBody = JSON.stringify({ target: "x", text: "evil-substitute" });
    const payload = buildFromSignPayload(FROM, ts, METHOD, PATH, hashBody(goodBody));
    const sig = hmacHex(secret, payload);
    // Sender signed goodBody; attacker re-uses signature against evilBody.
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": ts,
      },
      body: evilBody,
      lookupPubkey: lookup,
    });
    expect(decision.kind).toBe("refuse-mismatch");
  });

  test("invalid signed-at (non-parseable) → refuse-malformed", () => {
    const secret = randomKey("malformed-ts");
    const lookup: FromPubkeyLookup = () => secret;
    const ts = nowIso();
    const payload = buildFromSignPayload(FROM, ts, METHOD, PATH, hashBody(""));
    const sig = hmacHex(secret, payload);
    const decision = verifyRequest({
      method: METHOD,
      path: PATH,
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": "not-a-real-timestamp",
      },
      body: "",
      lookupPubkey: lookup,
    });
    expect(decision.kind).toBe("refuse-malformed");
  });

  test("verifyHmacSig rejects malformed signature (non-hex)", () => {
    expect(verifyHmacSig("secret", "payload", "not-hex-zzzz")).toBe(false);
  });

  test("verifyHmacSig length-gates before timing-safe compare", () => {
    // Empty signature must not throw and must not match.
    expect(verifyHmacSig("secret", "payload", "")).toBe(false);
    // Wrong-length signature returns false without false-positive.
    expect(verifyHmacSig("secret", "payload", "deadbeef")).toBe(false);
  });

  test("path tampering (signed /api/send, replayed against /api/wake) → refuse", () => {
    const secret = randomKey("path-bind");
    const lookup: FromPubkeyLookup = () => secret;
    const ts = nowIso();
    const payload = buildFromSignPayload(FROM, ts, METHOD, "/api/send", hashBody(""));
    const sig = hmacHex(secret, payload);
    const decision = verifyRequest({
      method: METHOD,
      path: "/api/wake", // replayed to a different protected endpoint
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature": sig,
        "x-maw-signed-at": ts,
      },
      body: "",
      lookupPubkey: lookup,
    });
    expect(decision.kind).toBe("refuse-mismatch");
  });
});
