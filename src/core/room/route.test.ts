import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { roomTag, messageInRoom, roomSendArgs, handleRoomSendRequest, handleRoomOpenRequest, handleRoomCloseRequest, handleRoomReopenRequest, handleRoomThreadRequest, handleRoomDistillRequest, handleRoomMergeRequest, handleRoomActivityRequest, handleRoomsListRequest } from "./route";
import { appendRoomMessage, readRoom } from "./store";
import { readTask } from "../tasks/store";
import { _setCompaniesDir, saveCompany, COMPANIES_DIR } from "../../vendor/mpr-plugins/company/company-helpers";

const origCompaniesDir = COMPANIES_DIR;
// A room is ALWAYS ⊂ a company (kobo-258 open-guard), so the artifact-route tests seed a
// real company registry in the temp dir. Helper: point company-helpers at <dir>/companies
// and register the given companies (each with a `core` dept lead = its warroom lead).
function seedCompanies(dir: string, companies: Record<string, string>): void {
  _setCompaniesDir(join(dir, "companies"));
  for (const [name, lead] of Object.entries(companies)) {
    saveCompany({ name, departments: { core: { lead, kbTag: "kb", members: [{ oracle: lead, role: "lead" }] } } });
  }
}

const post = (body: unknown, spawn?: (a: string[]) => { exited: Promise<number> }) =>
  handleRoomSendRequest(
    new Request("http://x/api/room/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    spawn,
  );

describe("Brainstorm Room core wire (kobo-245)", () => {
  // kobo-249: /room/send now reads the room store (persist-at-send). Point it at an empty
  // temp home so these wire-only tests never touch real ~/.maw rooms.
  // Hermetic-fix: /room/send's openR path hits the kobo-258 open-guard (companyExists),
  // which reads company-helpers' FROZEN COMPANIES_DIR (= real ~/.maw at import). Without a
  // registered company these tests passed LOCALLY (real ~/.maw has kobo) but were CI-fragile
  // (empty ~/.maw → companyExists false → 404). Seed the company registry into the temp dir
  // so the guard is satisfied hermetically; restore the frozen dir after.
  let dir: string; const prev = process.env.MAW_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-roomsend-")); process.env.MAW_DATA_DIR = dir; seedCompanies(dir, { kobo: "eq3" }); });
  afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; _setCompaniesDir(origCompaniesDir); rmSync(dir, { recursive: true, force: true }); });

  test("roomTag / messageInRoom scope a message to one room", () => {
    expect(roomTag("demo")).toBe("[room:demo]");
    expect(messageInRoom("[room:demo] hi", "demo")).toBe(true);
    expect(messageInRoom("[room:other] hi", "demo")).toBe(false);
    expect(messageInRoom(undefined, "demo")).toBe(false);
  });

  test("roomSendArgs stamps the web author (--from web:<name>) so the turn isn't the host oracle (kobo-248)", () => {
    expect(roomSendArgs("demo", "eq3", "what next?")).toEqual(["hey", "--from", "web:web", "eq3", "[room:demo] what next?"]); // default author
    expect(roomSendArgs("demo", "eq3", "hi", "tony")).toEqual(["hey", "--from", "web:tony", "eq3", "[room:demo] hi"]); // named human
    expect(roomSendArgs("demo", "eq3", "hi", "m5:eq3")[2]).toBe("web:m5eq3"); // sanitized to the sender-part charset (no stray ':')
  });

  test("POST /api/room/send delivers via the injected hey spawn, tagged web:<from> (kobo-248)", async () => {
    const calls: string[][] = [];
    const spawn = (argv: string[]) => { calls.push(argv); return { exited: Promise.resolve(0) }; };
    const res = await post({ room: "demo", to: "eq3", text: "hello lead", from: "web" }, spawn);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(calls).toEqual([["hey", "--from", "web:web", "eq3", "[room:demo] hello lead"]]); // one hey, web-attributed
  });

  test("missing room/to/text → 400; bad JSON → 400 (no spawn)", async () => {
    const calls: string[][] = [];
    const spawn = (argv: string[]) => { calls.push(argv); return { exited: Promise.resolve(0) }; };
    expect((await post({ to: "eq3", text: "x" }, spawn)).status).toBe(400); // no room
    expect((await post({ room: "demo", text: "x" }, spawn)).status).toBe(400); // no lead
    expect((await post({ room: "demo", to: "eq3" }, spawn)).status).toBe(400); // no text
    const bad = await handleRoomSendRequest(new Request("http://x/api/room/send", { method: "POST", headers: { "content-type": "application/json" }, body: "nope" }), spawn);
    expect(bad.status).toBe(400);
    expect(calls).toEqual([]); // nothing delivered on a bad request
  });

  // kobo-249 (finding #3, DATA-LOSS): persist rode the idle-gated DELIVERY feed event,
  // so a send to a busy lead pane lagged the artifact +40s / lost turns. The send handler
  // now writes the outbound turn to the artifact SYNCHRONOUSLY (source of truth).
  const noopSpawn = () => ({ exited: Promise.resolve(0) });
  const openR = (b: unknown) => handleRoomOpenRequest(new Request("http://x/api/room/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

  test("a send persists the turn synchronously under web:<author> — no feed/delivery event needed", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const res = await post({ room: "r", to: "eq3", text: "urgent turn", from: "tony" }, noopSpawn);
    expect(res.status).toBe(200);
    const room = readRoom("kobo", "r")!;
    expect(room.messages).toHaveLength(1); // present IMMEDIATELY, not after delivery drains
    // persisted under the SAME web:<author> the hey stamps via --from (kobo-248), so the
    // lagging feed event dedups against it.
    expect(room.messages[0]).toMatchObject({ from: "web:tony", text: "urgent turn" });
  });

  test("the lagging delivery feed event for the SAME turn is deduped (no double-persist)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    await post({ room: "r", to: "eq3", text: "hi" }, noopSpawn); // default author → web:web
    // the delayed feed event arrives later with a DIFFERENT random lifecycle id but the
    // same (from, text), inside the send-dedup window — the listener path lands here.
    appendRoomMessage("kobo", "r", { id: "random-lifecycle-id", from: "web:web", text: "hi", ts: Date.now() + 40_000 });
    expect(readRoom("kobo", "r")!.messages).toHaveLength(1); // still one — deduped
  });

  test("a lead reply (different text) still persists — slice-1 round-trip intact", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    await post({ room: "r", to: "eq3", text: "question" }, noopSpawn);
    appendRoomMessage("kobo", "r", { id: "lead-1", from: "m5:eq3", text: "answer", ts: Date.now() });
    expect(readRoom("kobo", "r")!.messages.map((m) => m.text)).toEqual(["question", "answer"]);
  });

  test("send to an UNOPENED room delivers but persists nothing (no artifact minted)", async () => {
    const calls: string[][] = [];
    const res = await post({ room: "ghost", to: "eq3", text: "x" }, (a) => { calls.push(a); return { exited: Promise.resolve(0) }; });
    expect(res.status).toBe(200); // delivery still best-effort
    expect(calls).toHaveLength(1); // hey still spawned
    expect(readRoom("kobo", "ghost")).toBeNull(); // stray traffic never mints an artifact
  });
});

describe("Brainstorm Room artifact routes (kobo-241 — open/close/reopen/thread)", () => {
  let dir: string; const prev = process.env.MAW_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-roomroute-")); process.env.MAW_DATA_DIR = dir; seedCompanies(dir, { kobo: "eq3" }); });
  afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; _setCompaniesDir(origCompaniesDir); rmSync(dir, { recursive: true, force: true }); });

  const openR = (b: unknown) => handleRoomOpenRequest(new Request("http://x/api/room/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const closeR = (b: unknown) => handleRoomCloseRequest(new Request("http://x/api/room/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const reopenR = (b: unknown) => handleRoomReopenRequest(new Request("http://x/api/room/reopen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const thread = (q: string) => handleRoomThreadRequest(new Request("http://x/api/room/thread?" + q));

  test("open → thread persists → close → reopen reloads the full thread", async () => {
    const o = await openR({ company: "kobo", room: "demo", topic: "what to build" });
    expect(o.status).toBe(200);
    expect(((await o.json()) as { room: { status: string; topic: string } }).room).toMatchObject({ status: "open", topic: "what to build" });
    appendRoomMessage("kobo", "demo", { id: "m1", from: "web", text: "hi", ts: 1 }); // simulate a captured turn
    // thread read returns the persisted artifact
    const t = await thread("company=kobo&room=demo").json() as { ok: boolean; room: { messages: unknown[]; status: string } };
    expect(t.room.messages).toHaveLength(1);
    // close keeps the thread
    const closed = await (await closeR({ company: "kobo", room: "demo" })).json() as { room: { status: string } };
    expect(closed.room.status).toBe("closed");
    // reopen reloads it
    const re = await (await reopenR({ company: "kobo", room: "demo" })).json() as { room: { status: string; messages: unknown[] } };
    expect(re.room.status).toBe("open");
    expect(re.room.messages).toHaveLength(1);
  });

  test("activity → participants from the thread (worklog/presence absent → nulls); guards 400/404", async () => {
    await openR({ company: "kobo", room: "demo", topic: "t" });
    appendRoomMessage("kobo", "demo", { id: "m1", from: "conductor", text: "on it", ts: 1 });
    const act = (q: string) => handleRoomActivityRequest(new Request("http://x/api/room/activity?" + q));
    const j = await act("company=kobo&room=demo").json() as { ok: boolean; participants: Array<{ oracle: string; activity: string | null; busy: boolean }> };
    expect(j.participants.map((p) => p.oracle)).toEqual(["conductor"]);
    expect(j.participants[0]).toMatchObject({ activity: null, busy: false }); // no worklog/presence in the temp dir
    expect(act("company=kobo").status).toBe(400); // no room
    expect(act("company=kobo&room=ghost").status).toBe(404); // absent room
  });

  test("thread without room → the room list; guards: missing fields → 400/404", async () => {
    await openR({ company: "kobo", room: "a", topic: "ta" });
    const list = await thread("company=kobo").json() as { ok: boolean; rooms: Array<{ id: string }> };
    expect(list.rooms.map((r) => r.id)).toEqual(["a"]);
    expect(thread("").status).toBe(400); // no company
    expect((await closeR({ company: "kobo", room: "ghost" })).status).toBe(404); // absent room
    expect((await openR({ company: "kobo" })).status).toBe(400); // no room
  });

  const distill = (b: unknown) => handleRoomDistillRequest(new Request("http://x/api/room/distill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

  test("distill promotes a room → a real kanban card with a bidirectional link (kobo-244)", async () => {
    await openR({ company: "kobo", room: "brainstorm", topic: "how to X" });
    const res = await distill({ company: "kobo", room: "brainstorm", title: "Build X", body: "problem+approach", assignee: "patchwork", reviewer: "eq3" });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; card: { id: string; title: string; room: string; assignee: string; reviewer: string; body: string }; room: { cardId: string } };
    expect(j.ok).toBe(true);
    // card was created via the REUSED addTask path (real card on the board, has an id)
    expect(j.card.title).toBe("Build X");
    expect(j.card.assignee).toBe("patchwork");
    expect(j.card.reviewer).toBe("eq3");
    expect(j.card.body).toBe("problem+approach");
    // bidirectional link — card→room (provenance) AND room→card (recorded)
    expect(j.card.room).toBe("brainstorm");
    expect(j.room.cardId).toBe(j.card.id);
    expect(readTask("kobo", j.card.id)!.room).toBe("brainstorm"); // persisted card side
    expect(readRoom("kobo", "brainstorm")!.cardId).toBe(j.card.id); // persisted artifact side
  });

  test("distill is idempotent — a re-distill returns the SAME card, no duplicate", async () => {
    await openR({ company: "kobo", room: "once", topic: "t" });
    const first = await (await distill({ company: "kobo", room: "once", title: "First" })).json() as { card: { id: string } };
    const again = await (await distill({ company: "kobo", room: "once", title: "Second attempt" })).json() as { card: { id: string; title: string }; deduped: boolean };
    expect(again.deduped).toBe(true);
    expect(again.card.id).toBe(first.card.id); // same card, not a second one
    expect(again.card.title).toBe("First"); // original card unchanged
  });

  test("distill guards: absent room → 404; missing title/company → 400", async () => {
    expect((await distill({ company: "kobo", room: "ghost", title: "x" })).status).toBe(404);
    await openR({ company: "kobo", room: "g", topic: "t" });
    expect((await distill({ company: "kobo", room: "g" })).status).toBe(400); // no title
    expect((await distill({ room: "g", title: "x" })).status).toBe(400); // no company
  });

  const mergeR = (b: unknown) => handleRoomMergeRequest(new Request("http://x/api/room/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

  test("merge REQUIRES confirm:true — the gate blocks an auto-merge (400, no write)", async () => {
    await openR({ company: "kobo", room: "t", topic: "survivor" });
    await openR({ company: "kobo", room: "s", topic: "same problem" });
    appendRoomMessage("kobo", "s", { id: "s1", from: "web", text: "src", ts: 1 });
    // no confirm → 400, and the source is untouched
    const blocked = await mergeR({ company: "kobo", target: "t", sources: ["s"] });
    expect(blocked.status).toBe(400);
    expect(readRoom("kobo", "s")!.status).toBe("open"); // NOT merged — nothing written
    expect(((await blocked.json()) as { error: string }).error).toContain("confirm");
  });

  test("merge with confirm:true consolidates; missing fields → 400; absent target → 404", async () => {
    await openR({ company: "kobo", room: "t", topic: "survivor" });
    await openR({ company: "kobo", room: "s", topic: "same problem" });
    appendRoomMessage("kobo", "s", { id: "s1", from: "web", text: "src", ts: 1 });
    const ok = await mergeR({ company: "kobo", target: "t", sources: ["s"], confirm: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { room: { mergedFrom: string[] } }).room.mergedFrom).toEqual(["s"]);
    expect(readRoom("kobo", "s")!.status).toBe("merged"); // archived, not deleted
    expect((await mergeR({ company: "kobo", target: "t", confirm: true })).status).toBe(400); // no sources
    expect((await mergeR({ company: "kobo", target: "ghost", sources: ["s"], confirm: true })).status).toBe(404);
  });
});

describe("Brainstorm Room company-scope + default lead (kobo-258)", () => {
  let dir: string; const prev = process.env.MAW_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-rooms-")); process.env.MAW_DATA_DIR = dir; seedCompanies(dir, { kobo: "eq3", pgw: "thawanban" }); });
  afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; _setCompaniesDir(origCompaniesDir); rmSync(dir, { recursive: true, force: true }); });

  const openR = (b: unknown) => handleRoomOpenRequest(new Request("http://x/api/room/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const rooms = (q: string) => handleRoomsListRequest(new Request("http://x/api/rooms" + q));

  test("GET /api/rooms is company-scoped + resolves the default lead + lists companies", async () => {
    await openR({ company: "kobo", room: "demo", topic: "what to build" });
    const j = await rooms("?company=kobo").json() as { ok: boolean; company: string; lead: string; companies: string[]; rooms: Array<{ id: string; topic: string }> };
    expect(j.company).toBe("kobo");
    expect(j.lead).toBe("eq3"); // kobo → core dept lead (default partner)
    expect(j.companies).toEqual(["kobo", "pgw"]); // selector options (name-sorted)
    expect(j.rooms.map((r) => r.id)).toEqual(["demo"]); // only THIS company's rooms
  });

  test("unknown/absent ?company falls back to the first company (never operates without one)", async () => {
    const none = await rooms("?company=ghost").json() as { company: string; lead: string };
    expect(none.company).toBe("kobo"); // ghost isn't real → default to the first
    expect(none.lead).toBe("eq3");
    const bare = await rooms("").json() as { company: string };
    expect(bare.company).toBe("kobo");
  });

  test("pgw resolves its company-level manager as lead (thawanban)", async () => {
    // pgw seeded with a core lead, but a manager (if present) wins — seed one to prove precedence
    saveCompany({ name: "pgw", manager: "thawanban", departments: { core: { lead: "nai", kbTag: "kb", members: [] } } });
    const j = await rooms("?company=pgw").json() as { lead: string };
    expect(j.lead).toBe("thawanban"); // manager > dept lead
  });

  test("open enforces room ⊂ company — a room under an unknown company is rejected (no orphan)", async () => {
    expect((await openR({ company: "ghost", room: "x", topic: "t" })).status).toBe(404); // unknown company
    expect((await openR({ company: "kobo", room: "x", topic: "t" })).status).toBe(200); // real company OK
  });
});
