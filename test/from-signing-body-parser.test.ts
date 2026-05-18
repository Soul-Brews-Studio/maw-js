/**
 * #1790 — cross-node POST with from-signing should NOT fail with
 * 'body_read_failed' when the route has a `body:` schema declared
 * (Elysia parses + consumes the body stream before onBeforeHandle runs).
 *
 * Reproduces the symptom by mounting fromSigningAuth + HMAC plugin in front
 * of a route that declares `body: t.Object(...)`, then POSTing a signed
 * request through the full Elysia pipeline.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia, t } from "elysia";
import { fromSigningAuth, federationAuth, setBunServer } from "../src/lib/elysia-auth";
import { signHeadersV3 } from "../src/lib/federation-auth";
import { writeFileSync, mkdtempSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIG_HOME = process.env.HOME;
const ORIG_PEER_KEY = process.env.MAW_PEER_KEY;
const TMP_HOME = mkdtempSync(join(tmpdir(), "maw-1790-"));
const SHARED_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(() => {
  // Isolate config + peers so test doesn't read real home
  process.env.HOME = TMP_HOME;
  process.env.MAW_PEER_KEY = SHARED_KEY;
  const cfgDir = join(TMP_HOME, ".config", "maw");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "maw.config.json"),
    JSON.stringify({
      federationToken: SHARED_KEY,
      node: "test-node",
      oracle: "mawjs",
      port: 3456,
      namedPeers: [{ name: "peer-a", url: "http://127.0.0.1:9999" }],
    }, null, 2),
  );
  // peers.json with peer-a stored pubkey = our SHARED_KEY (so verifier accepts)
  const mawDir = join(TMP_HOME, ".maw");
  mkdirSync(mawDir, { recursive: true });
  writeFileSync(
    join(mawDir, "peers.json"),
    JSON.stringify({
      version: 1,
      peers: {
        "peer-a": { url: "http://127.0.0.1:9999", node: "peer-a", pubkey: SHARED_KEY, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() },
      },
    }, null, 2),
  );
});

afterAll(() => {
  process.env.HOME = ORIG_HOME;
  if (ORIG_PEER_KEY) process.env.MAW_PEER_KEY = ORIG_PEER_KEY;
  else delete process.env.MAW_PEER_KEY;
});

describe("#1790 from-signing with parsed body schema", () => {
  test("POST with body:schema + from-signed request succeeds (no body_read_failed)", async () => {
    // Fake a non-loopback by NOT setting Bun server (the auth path treats
    // missing _bunServer + missing requestIP as non-loopback by default)
    const app = new Elysia()
      .use(federationAuth)
      .use(fromSigningAuth)
      .post("/api/wake",
        ({ body }) => ({ ok: true, target: (body as { target: string }).target }),
        { body: t.Object({ target: t.String() }) },
      );

    const bodyStr = JSON.stringify({ target: "test-oracle" });
    const ts = Math.floor(Date.now() / 1000);

    // Sign with v3 from-signing (peerKey = our shared key)
    const v3 = signHeadersV3({
      peerKey: SHARED_KEY,
      fromAddress: "mawjs:peer-a",
      method: "POST",
      path: "/api/wake",
      body: bodyStr,
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-maw-from": "mawjs:peer-a",
      "x-maw-signature-v3": v3.signature,
      "x-maw-timestamp": String(ts),
      "x-maw-auth-version": "v3",
    };

    const res = await app.handle(new Request("http://localhost/api/wake", {
      method: "POST",
      headers,
      body: bodyStr,
    }));

    expect(res.status).not.toBe(401);
    // We don't care that the wake itself succeeds (might fail in test env);
    // we only assert that auth didn't reject for body_read_failed.
    const text = await res.text();
    expect(text).not.toContain("body_read_failed");
  });
});
