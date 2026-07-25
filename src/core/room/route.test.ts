import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { roomTag, messageInRoom, roomNudgeArgs, handleRoomSendRequest, handleRoomOpenRequest, handleRoomCloseRequest, handleRoomReopenRequest, handleRoomThreadRequest, handleRoomDistillRequest, handleRoomMergeRequest, handleRoomActivityRequest, handleRoomsListRequest, handleRoomReplyRequest, handleRoomInviteRequest } from "./route";
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
    saveCompany({ name, teams: { core: { lead, members: [{ oracle: lead, role: "lead" }] } } });
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

  test("roomNudgeArgs is PLAIN/UNTAGGED + queue-on-away — reaches an away lead on /seat (kobo-260/306)", () => {
    const args = roomNudgeArgs("demo", "eq3", "web");
    expect(args.slice(0, 3)).toEqual(["hey", "--from", "web:web"]); // still web-attributed (kobo-248)
    // kobo-306 — the nudge opts into queue-on-away so an away lead still learns of the turn on return
    expect(args).toContain("--queue-on-away");
    const to = args[args.length - 2];
    const msg = args[args.length - 1];
    expect(to).toBe("eq3"); // to the lead
    expect(msg).not.toContain("[room:"); // NO tag → the room feed listener ignores it (no self-echo)
    expect(msg).toContain("demo"); // but still tells the lead which room
  });

  test("POST /api/room/send nudges the lead with an UNTAGGED hey (kobo-260 — no self-echo)", async () => {
    const calls: string[][] = [];
    const spawn = (argv: string[]) => { calls.push(argv); return { exited: Promise.resolve(0) }; };
    const res = await post({ room: "demo", to: "eq3", text: "hello lead", from: "web" }, spawn);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual(["hey", "--from", "web:web"]); // one nudge to the lead
    expect(calls[0]).toContain("--queue-on-away"); // kobo-306 — reaches an away lead on /seat
    expect(calls[0][calls[0].length - 2]).toBe("eq3"); // to the lead
    expect(calls[0][calls[0].length - 1]).not.toContain("[room:"); // untagged message
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

  test("a send persists the turn synchronously under the BARE author — renders as the human (kobo-260)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const res = await post({ room: "r", to: "eq3", text: "urgent turn", from: "tony" }, noopSpawn);
    expect(res.status).toBe(200);
    const room = readRoom("kobo", "r")!;
    expect(room.messages).toHaveLength(1); // present IMMEDIATELY, not after delivery drains
    // kobo-260: stored under the BARE identity ("tony"), the same one roleOf renders as the
    // human — NOT the raw "web:tony" that used to render as a teammate.
    expect(room.messages[0]).toMatchObject({ from: "tony", text: "urgent turn" });
  });

  test("send persists EXACTLY ONCE — the untagged nudge can't self-echo (kobo-260, finding #4)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const calls: string[][] = [];
    await post({ room: "r", to: "eq3", text: "hi" }, (a) => { calls.push(a); return { exited: Promise.resolve(0) }; });
    // the nudge is untagged, so onRoomFeedEvent (which only captures [room:<id>] heys) is a
    // no-op for it — nothing re-persists the web turn. Exactly one message, from the human.
    const msgs = readRoom("kobo", "r")!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe("web");
    expect(calls[0][calls[0].length - 1]).not.toContain("[room:"); // proves the nudge carries no tag to re-capture
  });

  test("Rule-6: the web side can't send AS a company oracle (no impersonating a teammate)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const res = await post({ room: "r", to: "eq3", text: "sneaky", from: "eq3" }, noopSpawn); // eq3 = kobo lead
    expect(res.status).toBe(403);
    expect(readRoom("kobo", "r")!.messages).toHaveLength(0); // nothing written
  });

  test("send to an UNOPENED room delivers but persists nothing (no artifact minted)", async () => {
    const calls: string[][] = [];
    const res = await post({ room: "ghost", to: "eq3", text: "x" }, (a) => { calls.push(a); return { exited: Promise.resolve(0) }; });
    expect(res.status).toBe(200); // delivery still best-effort
    expect(calls).toHaveLength(1); // nudge still spawned
    expect(readRoom("kobo", "ghost")).toBeNull(); // stray traffic never mints an artifact
  });

  // ── kobo-260: reply primitive + invite ──
  const reply = (b: unknown) => handleRoomReplyRequest(new Request("http://x/api/room/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const inviteR = (b: unknown, spawn = noopSpawn) => handleRoomInviteRequest(new Request("http://x/api/room/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), spawn);

  test("reply writes the lead's turn directly into the artifact — no pane hack (kobo-260)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const res = await reply({ company: "kobo", room: "r", from: "eq3", text: "here is my answer" });
    expect(res.status).toBe(200);
    const msgs = readRoom("kobo", "r")!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from: "eq3", text: "here is my answer" }); // attributed to the lead
  });

  test("Rule-6: reply `from` is server-verified — human/web or unknown is rejected 403", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    expect((await reply({ company: "kobo", room: "r", from: "web", text: "x" })).status).toBe(403); // can't reply as the human
    expect((await reply({ company: "kobo", room: "r", from: "tony", text: "x" })).status).toBe(403); // random human name
    expect((await reply({ company: "kobo", room: "r", from: "randobot", text: "x" })).status).toBe(403); // not an oracle of the room
    expect(readRoom("kobo", "r")!.messages).toHaveLength(0);
    expect((await reply({ company: "kobo", room: "ghost", from: "eq3", text: "x" })).status).toBe(404); // absent room
    expect((await reply({ company: "kobo", room: "r", text: "x" })).status).toBe(400); // no from
  });

  test("an invited (cross-company) teammate may reply — participant unlocks the Rule-6 gate", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    // thawanban is pgw's lead, NOT a kobo oracle — but once invited into the kobo room they can reply
    expect((await reply({ company: "kobo", room: "r", from: "thawanban", text: "early" })).status).toBe(403);
    await inviteR({ company: "kobo", room: "r", oracle: "thawanban" });
    expect((await reply({ company: "kobo", room: "r", from: "thawanban", text: "now allowed" })).status).toBe(200);
  });

  test("invite records the teammate + sends exactly one plain notify hey (kobo-260)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const calls: string[][] = [];
    const res = await inviteR({ company: "kobo", room: "r", oracle: "worker-2" }, (a) => { calls.push(a); return { exited: Promise.resolve(0) }; });
    expect(res.status).toBe(200);
    expect(readRoom("kobo", "r")!.participants).toEqual(["worker-2"]); // recorded on the artifact
    expect(calls).toHaveLength(1); // exactly one hey
    expect(calls[0][0]).toBe("hey"); expect(calls[0][1]).toBe("worker-2");
    expect(calls[0][2]).toContain("/room?company=kobo"); // deep-link to the room
    expect(calls[0][2]).not.toContain("[room:"); // untagged notify — no re-capture
  });

  test("invite guards: absent room → 404; missing oracle → 400; can't invite web → 400", async () => {
    expect((await inviteR({ company: "kobo", room: "ghost", oracle: "x" })).status).toBe(404);
    await openR({ company: "kobo", room: "r", topic: "t" });
    expect((await inviteR({ company: "kobo", room: "r" })).status).toBe(400); // no oracle
    expect((await inviteR({ company: "kobo", room: "r", oracle: "web" })).status).toBe(400); // can't invite the human
  });
});

describe("kobo-385: @tag overrides the hey target — POST /api/room/send directly (bypass web client)", () => {
  let dir: string; const prev = process.env.MAW_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-roomtag-")); process.env.MAW_DATA_DIR = dir; seedCompanies(dir, { kobo: "eq3" }); });
  afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; _setCompaniesDir(origCompaniesDir); rmSync(dir, { recursive: true, force: true }); });

  const openR = (b: unknown) => handleRoomOpenRequest(new Request("http://x/api/room/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const inviteR = (b: unknown) => handleRoomInviteRequest(new Request("http://x/api/room/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), () => ({ exited: Promise.resolve(0) }));
  const spawnSpy = () => { const calls: string[][] = []; return { calls, spawn: (a: string[]) => { calls.push(a); return { exited: Promise.resolve(0) }; } }; };
  const target = (argv: string[]) => argv[argv.length - 2]; // roomNudgeArgs' `to` is second-to-last

  test("@member in room → the REAL hey target is the member, not the UI's default lead", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    await inviteR({ company: "kobo", room: "r", oracle: "worker" });
    const { calls, spawn } = spawnSpy();
    const res = await post({ room: "r", to: "eq3", text: "@worker please pick this up", from: "web" }, spawn);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { to: string }).to).toBe("worker"); // response surfaces the resolved target
    expect(target(calls[0])).toBe("worker"); // the actual hey argv target
  });

  test("no @tag → target stays the default lead (behavior unchanged)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { calls, spawn } = spawnSpy();
    const res = await post({ room: "r", to: "eq3", text: "no tag here", from: "web" }, spawn);
    expect(((await res.json()) as { to: string }).to).toBe("eq3");
    expect(target(calls[0])).toBe("eq3");
  });

  test("@nonmember → falls back to lead, but the response SURFACES the resolved (real) destination", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { calls, spawn } = spawnSpy();
    const res = await post({ room: "r", to: "eq3", text: "@ghost are you there", from: "web" }, spawn);
    expect(((await res.json()) as { to: string }).to).toBe("eq3"); // never the un-resolved "@ghost"
    expect(target(calls[0])).toBe("eq3");
  });

  test("attacker path: from:'tony' + text '@tony' → hard-deny holds; tony is NEVER a hey target", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { calls, spawn } = spawnSpy();
    const res = await post({ room: "r", to: "eq3", text: "@tony ping", from: "tony" }, spawn);
    expect(((await res.json()) as { to: string }).to).toBe("eq3"); // falls back to lead
    expect(target(calls[0])).toBe("eq3");
    expect(calls.flat()).not.toContain("tony"); // "tony" never appears anywhere in the hey argv
  });

  test("@ mid-word / email-shaped text never matches (word-anchored regex)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    await inviteR({ company: "kobo", room: "r", oracle: "com" }); // would match if the anchor were broken
    const { calls, spawn } = spawnSpy();
    await post({ room: "r", to: "eq3", text: "ping me at a@b.com", from: "web" }, spawn);
    expect(target(calls[0])).toBe("eq3");
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

  test("thread read is default-capped + paged by last/since/all (kobo-322)", async () => {
    await openR({ company: "kobo", room: "big", topic: "t" });
    for (let i = 1; i <= 50; i++) appendRoomMessage("kobo", "big", { id: `m${i}`, from: "a", text: `x${i}`, ts: i }); // unique text → skip the from+text send-dedup window
    type Body = { room: { messages: Array<{ id: string; ts: number }> }; totalMessages: number; returnedMessages: number; truncated: boolean };

    // no param → default cap (last 20), flagged truncated + totals intact
    const def = await thread("company=kobo&room=big").json() as Body;
    expect(def.room.messages).toHaveLength(20);
    expect(def.totalMessages).toBe(50);
    expect(def.returnedMessages).toBe(20);
    expect(def.truncated).toBe(true);
    expect(def.room.messages.at(-1)!.id).toBe("m50");

    // last N
    const l = await thread("company=kobo&room=big&last=10").json() as Body;
    expect(l.room.messages).toHaveLength(10);
    expect(l.room.messages[0].id).toBe("m41");

    // since ts (epoch ms — turns are ts 1..50)
    const s = await thread("company=kobo&room=big&since=45").json() as Body;
    expect(s.room.messages.map((m) => m.ts)).toEqual([45, 46, 47, 48, 49, 50]);

    // all → full room, not truncated
    const a = await thread("company=kobo&room=big&all=1").json() as Body;
    expect(a.room.messages).toHaveLength(50);
    expect(a.truncated).toBe(false);

    // since ISO string also parses
    const iso = await thread(`company=kobo&room=big&since=${encodeURIComponent(new Date(48).toISOString())}`).json() as Body;
    expect(iso.room.messages.map((m) => m.ts)).toEqual([48, 49, 50]);

    // malformed since → 400 explicit error (never a silent empty result)
    const bad = thread("company=kobo&room=big&since=notadate");
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toContain("invalid since");

    // negative last → 400
    expect(thread("company=kobo&room=big&last=-3").status).toBe(400);
  });

  // kobo-357: offset pages backward through history — skip N from the tail, then last N.
  test("thread read is paged by offset (kobo-357)", async () => {
    await openR({ company: "kobo", room: "paged", topic: "t" });
    for (let i = 1; i <= 50; i++) appendRoomMessage("kobo", "paged", { id: `m${i}`, from: "a", text: `y${i}`, ts: i });
    type Body = { room: { messages: Array<{ id: string; ts: number }> } };

    // last:6 offset:6 → the 7th-12th newest (ts 39..44)
    const paged = await thread("company=kobo&room=paged&last=6&offset=6").json() as Body;
    expect(paged.room.messages.map((m) => m.ts)).toEqual([39, 40, 41, 42, 43, 44]);

    // offset without last → applied against the default cap
    const noLast = await thread("company=kobo&room=paged&offset=10").json() as Body;
    expect(noLast.room.messages).toHaveLength(20);
    expect(noLast.room.messages.at(-1)!.ts).toBe(40);

    // negative offset → 400 explicit error
    const bad = thread("company=kobo&room=paged&offset=-3");
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toContain("invalid offset");

    // offset > available → empty, not an error
    const empty = await thread("company=kobo&room=paged&last=5&offset=999").json() as Body;
    expect(empty.room.messages).toHaveLength(0);
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
    saveCompany({ name: "pgw", manager: "thawanban", teams: { core: { lead: "nai", members: [] } } });
    const j = await rooms("?company=pgw").json() as { lead: string };
    expect(j.lead).toBe("thawanban"); // manager > dept lead
  });

  test("open enforces room ⊂ company — a room under an unknown company is rejected (no orphan)", async () => {
    expect((await openR({ company: "ghost", room: "x", topic: "t" })).status).toBe(404); // unknown company
    expect((await openR({ company: "kobo", room: "x", topic: "t" })).status).toBe(200); // real company OK
  });
});

describe("Room write-gate: closed/merged rooms reject POST /api/room/reply + /api/room/send (kobo-296)", () => {
  let dir: string; const prev = process.env.MAW_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-roomgate-")); process.env.MAW_DATA_DIR = dir; seedCompanies(dir, { kobo: "eq3" }); });
  afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; _setCompaniesDir(origCompaniesDir); rmSync(dir, { recursive: true, force: true }); });

  const openR = (b: unknown) => handleRoomOpenRequest(new Request("http://x/api/room/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const closeR = (b: unknown) => handleRoomCloseRequest(new Request("http://x/api/room/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const mergeR = (b: unknown) => handleRoomMergeRequest(new Request("http://x/api/room/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const reply = (b: unknown) => handleRoomReplyRequest(new Request("http://x/api/room/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const noopSpawn = () => ({ exited: Promise.resolve(0) });
  const send = (b: unknown, spawn = noopSpawn) => handleRoomSendRequest(new Request("http://x/api/room/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), spawn);

  test("reply rejected 403 on a closed room — message NOT persisted, reason names status (kobo-296)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    await closeR({ company: "kobo", room: "r" });
    const res = await reply({ company: "kobo", room: "r", from: "eq3", text: "late msg" });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("closed");
    expect(readRoom("kobo", "r")!.messages).toHaveLength(0); // not persisted
  });

  test("reply rejected 403 on a merged room — message NOT persisted (kobo-296)", async () => {
    await openR({ company: "kobo", room: "src", topic: "s" });
    await openR({ company: "kobo", room: "tgt", topic: "t" });
    await mergeR({ company: "kobo", target: "tgt", sources: ["src"], confirm: true });
    const res = await reply({ company: "kobo", room: "src", from: "eq3", text: "msg to merged" });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("merged");
    expect(readRoom("kobo", "src")!.messages).toHaveLength(0); // not persisted
  });

  test("reply on an open room still works — regression guard (kobo-296)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const res = await reply({ company: "kobo", room: "r", from: "eq3", text: "valid reply" });
    expect(res.status).toBe(200);
    expect(readRoom("kobo", "r")!.messages).toHaveLength(1);
  });

  test("send rejected 403 on a closed room — message NOT persisted, no nudge fired (kobo-296)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    await closeR({ company: "kobo", room: "r" });
    const calls: string[][] = [];
    const spawn = (argv: string[]) => { calls.push(argv); return { exited: Promise.resolve(0) }; };
    const res = await send({ room: "r", to: "eq3", text: "late msg", from: "tony" }, spawn);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("closed");
    expect(readRoom("kobo", "r")!.messages).toHaveLength(0); // not persisted
    expect(calls).toHaveLength(0); // no nudge fired
  });
});
