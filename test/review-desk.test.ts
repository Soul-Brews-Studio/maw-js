/**
 * Review Desk — durable human-in-the-loop approval plane (eq3-review-desk-maw).
 *
 * Two layers:
 *  - ReviewDeskStore (bun:sqlite) state machine: create / decide / single-use /
 *    expire / thread history / token lookup. Driven on an in-memory db.
 *  - The /api/review* routes through Elysia .handle(), on an isolated data dir.
 *
 * Delivery to the asker's session (dispatch engine) is best-effort and not
 * exercised here — without a tmux pane it resolves to delivered:false, which the
 * decision route surfaces without failing (cross-node / headless askers poll).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { Elysia } from "elysia";
import { ReviewDeskStore } from "../src/core/review-desk";

describe("ReviewDeskStore", () => {
  it("mints corr + 256-bit token + roundNo 1, defaults contentType=markdown", () => {
    const store = new ReviewDeskStore(":memory:");
    const row = store.create({ title: "T", asker: "mba:eq3", contextNote: "look", md: "# hi" });
    expect(row.roundNo).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.contentType).toBe("markdown");
    expect(row.corr.startsWith("rev-")).toBe(true);
    // base64url 32 bytes → 43 chars, comfortably > 128-bit
    expect(row.token.length).toBeGreaterThanOrEqual(43);
    expect(row.threadId.startsWith("th_")).toBe(true);
    store.close();
  });

  it("honors deadlineSec (default 24h)", () => {
    const store = new ReviewDeskStore(":memory:");
    const def = store.create({ title: "T", asker: "a", contextNote: "c", md: "m" });
    const ttlMs = Date.parse(def.expiresAt) - Date.parse(def.createdAt);
    expect(Math.round(ttlMs / 1000)).toBe(86_400);
    const short = store.create({ title: "T", asker: "a", contextNote: "c", md: "m", deadlineSec: 60 });
    expect(Math.round((Date.parse(short.expiresAt) - Date.parse(short.createdAt)) / 1000)).toBe(60);
    store.close();
  });

  it("looks up by token, returns null for an unknown token", () => {
    const store = new ReviewDeskStore(":memory:");
    const row = store.create({ title: "T", asker: "a", contextNote: "c", md: "m" });
    expect(store.getByToken(row.token)?.reviewId).toBe(row.reviewId);
    expect(store.getByToken("nope")).toBeNull();
    store.close();
  });

  it("decide() is single-use: approve then a repeat → already_decided", () => {
    const store = new ReviewDeskStore(":memory:");
    const row = store.create({ title: "T", asker: "a", contextNote: "c", md: "m" });
    const first = store.decide(row.token, { outcome: "approve", feedback: { comment: "lgtm" } });
    expect(first.ok).toBe(true);
    expect(first.row?.status).toBe("approved");
    expect(first.row?.feedback).toEqual({ comment: "lgtm" });
    // md is submit-time + immutable — decision never changes it (ADR-0002)
    expect(first.row?.md).toBe("m");
    const second = store.decide(row.token, { outcome: "reject" });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("already_decided");
    store.close();
  });

  it("return stores opaque feedback verbatim and marks status returned", () => {
    const store = new ReviewDeskStore(":memory:");
    const row = store.create({ title: "T", asker: "a", contextNote: "c", md: "m" });
    const feedback = { comment: "needs work", ink: { strokes: [[1, 2]] } };
    const res = store.decide(row.token, { outcome: "return", feedback });
    expect(res.ok).toBe(true);
    expect(res.row?.status).toBe("returned");
    expect(res.row?.feedback).toEqual(feedback); // opaque round-trip, shape untouched
    store.close();
  });

  it("expireDue() marks pending-past-deadline expired; never approves", () => {
    const store = new ReviewDeskStore(":memory:");
    const row = store.create({ title: "T", asker: "a", contextNote: "c", md: "m", deadlineSec: 60 });
    const future = Date.parse(row.expiresAt) + 1000;
    const due = store.expireDue(future);
    expect(due.length).toBe(1);
    expect(due[0].outcome).toBe("expired");
    expect(store.getByToken(row.token)?.status).toBe("expired");
    // a decision after expiry on an already-terminal round → already_decided
    expect(store.decide(row.token, { outcome: "approve" }, future).error).toBe("already_decided");
    store.close();
  });

  it("decide() on a not-yet-swept but past-deadline round → expired", () => {
    const store = new ReviewDeskStore(":memory:");
    const row = store.create({ title: "T", asker: "a", contextNote: "c", md: "m", deadlineSec: 60 });
    const res = store.decide(row.token, { outcome: "approve" }, Date.parse(row.expiresAt) + 1);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("expired");
    store.close();
  });

  it("threads: resubmit with threadId increments roundNo and builds history", () => {
    const store = new ReviewDeskStore(":memory:");
    const r1 = store.create({ title: "T", asker: "a", contextNote: "c", md: "v1" });
    store.decide(r1.token, { outcome: "return", feedback: { comment: "redo" } });
    const r2 = store.create({ title: "T", asker: "a", contextNote: "c", md: "v2", threadId: r1.threadId });
    expect(r2.roundNo).toBe(2);
    expect(r2.threadId).toBe(r1.threadId);
    const hist = store.history(r2.threadId, r2.roundNo);
    expect(hist.length).toBe(1);
    expect(hist[0].roundNo).toBe(1);
    expect(hist[0].outcome).toBe("return");
    store.close();
  });

  it("persists across reopen (survives restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-review-persist-"));
    const file = join(dir, "review-desk.sqlite");
    const a = new ReviewDeskStore(file);
    const row = a.create({ title: "T", asker: "a", contextNote: "c", md: "m" });
    a.close();
    const b = new ReviewDeskStore(file);
    expect(b.getByToken(row.token)?.reviewId).toBe(row.reviewId);
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("/api/review routes", () => {
  let dataDir: string;
  const SECRET = "test-desk-secret";
  // Snapshot + restore these — default-safe runs non-mock files in ONE bun
  // process, so a leaked MAW_DATA_DIR pollutes later files (e.g. the preflight
  // default-path test reads it).
  const original = { dataDir: process.env.MAW_DATA_DIR, secret: process.env.MAW_REVIEW_DESK_SECRET };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "maw-review-api-"));
    process.env.MAW_DATA_DIR = dataDir;
    process.env.MAW_REVIEW_DESK_SECRET = SECRET;
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (original.dataDir === undefined) delete process.env.MAW_DATA_DIR;
    else process.env.MAW_DATA_DIR = original.dataDir;
    if (original.secret === undefined) delete process.env.MAW_REVIEW_DESK_SECRET;
    else process.env.MAW_REVIEW_DESK_SECRET = original.secret;
  });

  async function makeApp() {
    const { reviewApi } = await import("../src/api/review");
    return new Elysia({ prefix: "/api" }).use(reviewApi);
  }
  const url = (p: string) => `http://local/api${p}`;
  const json = (res: Response) => res.json() as Promise<any>;

  it("POST /review mints token+url, rejects non-markdown and empty md", async () => {
    const app = await makeApp();
    const ok = await app.handle(
      new Request(url("/review"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", asker: "headless:tester", contextNote: "look", md: "# hi" }),
      }),
    );
    expect(ok.status).toBe(200);
    const body = await json(ok);
    expect(body.token).toBeTruthy();
    expect(body.roundNo).toBe(1);
    expect(body.url).toContain(body.token);
    expect(body.expiresAt).toBeTruthy();

    const ui = await app.handle(
      new Request(url("/review"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", asker: "x", contextNote: "c", md: "hi", contentType: "ui" }),
      }),
    );
    expect(ui.status).toBe(400);

    const noMd = await app.handle(
      new Request(url("/review"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", asker: "x", contextNote: "c" }),
      }),
    );
    expect(noMd.status).toBe(400);
  });

  it("GET /review/pending requires desk secret", async () => {
    const app = await makeApp();
    await app.handle(
      new Request(url("/review"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "P", asker: "headless:p", contextNote: "c", md: "m" }),
      }),
    );
    const unauth = await app.handle(new Request(url("/review/pending")));
    expect(unauth.status).toBe(401);
    const ok = await app.handle(
      new Request(url("/review/pending"), { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(ok.status).toBe(200);
    const body = await json(ok);
    expect(Array.isArray(body.pending)).toBe(true);
    expect(body.pending.some((s: any) => s.title === "P")).toBe(true);
    // summaries must not leak md
    expect(body.pending.every((s: any) => !("md" in s))).toBe(true);
  });

  it("desk flow: list via /pending → open + decide WITHOUT the asker's token", async () => {
    const app = await makeApp();
    // asker submits; the desk never sees this POST response / token.
    await app.handle(
      new Request(url("/review"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "DeskFlow", asker: "headless:df", contextNote: "c", md: "review me" }),
      }),
    );
    // desk lists with desk-secret and recovers the token from the snapshot.
    const snap = await json(
      await app.handle(new Request(url("/review/pending"), { headers: { authorization: `Bearer ${SECRET}` } })),
    );
    const item = snap.pending.find((s: any) => s.title === "DeskFlow");
    expect(item?.token).toBeTruthy(); // ← summary must carry the token (blocker fix)

    const env = await json(await app.handle(new Request(url(`/review/${item.token}`))));
    expect(env.md).toBe("review me");
    const dec = await app.handle(
      new Request(url(`/review/${item.token}/decision`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "approve", feedback: { comment: "ok" } }),
      }),
    );
    expect(dec.status).toBe(200);
    expect((await json(dec)).ok).toBe(true);
  });

  it("GET /:token returns envelope; decision is single-use and updates status", async () => {
    const app = await makeApp();
    const created = await json(
      await app.handle(
        new Request(url("/review"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "D", asker: "headless:d", contextNote: "c", md: "body" }),
        }),
      ),
    );
    const token = created.token;

    const env = await json(await app.handle(new Request(url(`/review/${token}`))));
    expect(env.md).toBe("body");
    expect(env.status).toBe("pending");
    expect(env.history).toEqual([]);

    const dec = await app.handle(
      new Request(url(`/review/${token}/decision`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "approve", feedback: { comment: "lgtm" } }),
      }),
    );
    expect(dec.status).toBe(200);
    const decBody = await json(dec);
    expect(decBody.ok).toBe(true);
    expect(decBody.outcome).toBe("approve");

    const again = await app.handle(
      new Request(url(`/review/${token}/decision`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "reject" }),
      }),
    );
    expect(again.status).toBe(409);

    const after = await json(await app.handle(new Request(url(`/review/${token}`))));
    expect(after.status).toBe("approved");
  });

  it("unknown token → 404; bad outcome → 400", async () => {
    const app = await makeApp();
    expect((await app.handle(new Request(url("/review/nope")))).status).toBe(404);
    const bad = await app.handle(
      new Request(url("/review/whatever/decision"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "nonsense" }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("GET /review/stream is SSE with desk secret", async () => {
    const app = await makeApp();
    expect((await app.handle(new Request(url("/review/stream")))).status).toBe(401);
    const res = await app.handle(
      new Request(url("/review/stream"), { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });
});
