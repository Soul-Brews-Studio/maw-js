import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { roomTag, messageInRoom, roomNudgeArgs, handleRoomSendRequest, handleRoomOpenRequest, handleRoomCloseRequest, handleRoomReopenRequest, handleRoomThreadRequest, handleRoomDistillRequest, handleRoomMergeRequest, handleRoomActivityRequest, handleRoomsListRequest, handleRoomReplyRequest, handleRoomInviteRequest, defaultSpawn } from "./route";
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

  test("a send persists the turn synchronously — always under the constant identity 'web' (kobo-260/386)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const res = await post({ room: "r", to: "eq3", text: "urgent turn", from: "tony" }, noopSpawn);
    expect(res.status).toBe(200);
    const room = readRoom("kobo", "r")!;
    expect(room.messages).toHaveLength(1); // present IMMEDIATELY, not after delivery drains
    // kobo-386: the persisted identity is the CONSTANT "web", never the caller-supplied name.
    // A prior version stored the bare typed name ("tony") believing it "renders as the human" —
    // wrong: roleOf() only treats "web"/"you" as human, so any other string rendered as an
    // impersonated TEAMMATE. Nothing in the request path verifies `from`, so this was a real
    // attacker-controlled identity spoof.
    expect(room.messages[0]).toMatchObject({ from: "web", text: "urgent turn" });
  });

  // kobo-386 — attacker path: raw-POST with an arbitrary `from` must never become the
  // persisted speaker of record. Mirrors kobo-385's attacker-path test shape.
  test("attacker path: raw-POST with from:'tony' → persisted identity is 'web', NOT the spoofed name", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const res = await post({ room: "r", to: "eq3", text: "fake message", from: "tony" }, noopSpawn);
    expect(res.status).toBe(200);
    const msgs = readRoom("kobo", "r")!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe("web");
    expect(msgs[0].from).not.toBe("tony");
  });

  // kobo-598 — crew reviewer's HOLD finding (card comment c2/c3): an id that resolves
  // under NO company at all (findRoomCompany returns null) is the ORIGINAL kobo-245
  // hey-relay-only contract — still delivers, deliberately not removed here. eq3's ruling
  // (c3, option 2): the response must say so explicitly (persisted:false, relayOnly:true)
  // rather than let a bare ok:true imply the turn was saved when it wasn't.
  test("kobo-598: untracked room id (no company resolves) still relays — but the response says persisted:false, relayOnly:true", async () => {
    const calls: string[][] = [];
    const res = await post({ room: "no-such-room-xyz", to: "eq3", text: "hi", from: "tony" }, (a) => { calls.push(a); return { exited: Promise.resolve(0) }; });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; persisted?: boolean; relayOnly?: boolean; note?: string };
    expect(json.ok).toBe(true); // relay is a real, kept capability — not flipped to failure
    expect(json.persisted).toBe(false); // but the response must say nothing was saved
    expect(json.relayOnly).toBe(true);
    expect(json.note).toBeTruthy();
    expect(calls).toHaveLength(1); // the nudge still fires — kobo-245 contract intact
  });

  test("kobo-598: a room that DOES resolve under a company reports persisted:true, relayOnly:false", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const res = await post({ room: "r", to: "eq3", text: "hi", from: "web", company: "kobo" }, noopSpawn);
    const json = (await res.json()) as { ok: boolean; persisted?: boolean; relayOnly?: boolean };
    expect(json.ok).toBe(true);
    expect(json.persisted).toBe(true);
    expect(json.relayOnly).toBe(false);
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

  // kobo-598: room ids are NOT globally unique — confirmed live, both "kobo" and "demo"
  // had an open "head-crew-skill" room. Every test above only ever seeds ONE company, so
  // none of them could have caught this: findRoomCompany's first-match-across-every-company
  // scan silently picks whichever company's rooms/ dir happens to be listed first, and the
  // web turn lands there — while the human, looking at what they think is THEIR company's
  // room, sees no change and a `ok:true` response that gives no hint anything went wrong.
  test("kobo-598: explicit company in the body wins over a same-id room existing under a DIFFERENT company", async () => {
    await openR({ company: "kobo", room: "same-id", topic: "t" });
    seedCompanies(dir, { demo: "eq3demo" }); // additive — kobo from beforeEach stays registered
    await openR({ company: "demo", room: "same-id", topic: "t" });

    const res = await post({ room: "same-id", to: "eq3", text: "for kobo only", from: "web", company: "kobo" }, noopSpawn);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const kobo = readRoom("kobo", "same-id")!;
    const demo = readRoom("demo", "same-id")!;
    expect(kobo.messages.map((m) => m.text)).toContain("for kobo only"); // landed where the caller said
    expect(demo.messages.map((m) => m.text)).not.toContain("for kobo only"); // NOT in the same-id sibling
  });

  test("kobo-598: unknown company in the body → 404, no persist, no nudge", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const calls: string[][] = [];
    const res = await post({ room: "r", to: "eq3", text: "x", from: "web", company: "does-not-exist" }, (a) => { calls.push(a); return { exited: Promise.resolve(0) }; });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(readRoom("kobo", "r")!.messages).toHaveLength(0); // nothing persisted
    expect(calls).toEqual([]); // never reached the nudge
  });

  // kobo-598 AC: "Given persist fails, When responding, Then must NEVER answer ok:true" +
  // "must NOT nudge" — appendRoomMessage returns null when the company resolves but no open
  // artifact exists there for this room id (e.g. the room was only ever opened elsewhere).
  // Previously that null return was discarded entirely; the handler fell through to ok:true
  // and still spawned the nudge, exactly the receipt-lies-about-what-it-verified shape
  // kobo-596 closed for `maw hey`. This is the mutation-provable case: the write is
  // observably absent, so the response must say so and the nudge must never fire.
  test("kobo-598: persist genuinely fails (company resolved, no artifact there) → ok:false, spawn never called", async () => {
    // "kobo" is a real, registered company (companyExists passes) but "ghost-room" was
    // never opened under it — appendRoomMessage's own existsSync(path) guard returns null.
    const calls: string[][] = [];
    const res = await post({ room: "ghost-room", to: "eq3", text: "x", from: "web", company: "kobo" }, (a) => { calls.push(a); return { exited: Promise.resolve(0) }; });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("ghost-room");
    expect(calls).toEqual([]); // the nudge must never fire on a failed persist
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

  // kobo-391 — attacker path, mirrors kobo-385/386's shape: invite had its own partial deny
  // (only "web") instead of reusing ROOM_TAG_DENY, so "tony"/"human" sailed through.
  test("attacker path: POST /api/room/invite oracle:'tony' and oracle:'human' → both REJECTED", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const tonyRes = await inviteR({ company: "kobo", room: "r", oracle: "tony" });
    expect(tonyRes.status).toBe(400);
    const humanRes = await inviteR({ company: "kobo", room: "r", oracle: "human" });
    expect(humanRes.status).toBe(400);
  });

  // kobo-391 — chain regression: the invite gap didn't just add a bogus participant, it
  // poisoned roomRepliers()'s allowlist (unions room.participants), so a later reply could
  // impersonate the invited pseudo-identity. Pin the full chain stays closed.
  test("regression: invite can no longer poison reply's allowlist via participants", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    await inviteR({ company: "kobo", room: "r", oracle: "tony" }); // rejected now (400), no participant added
    const replyRes = await handleRoomReplyRequest(new Request("http://x/api/room/reply", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: "kobo", room: "r", from: "tony", text: "impersonated reply" }),
    }));
    expect(replyRes.status).toBe(403); // "tony" never entered roomRepliers — reply still rejects it
    expect(readRoom("kobo", "r")!.messages).toHaveLength(0);
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

  test("attacker path (TAG vector): from:'tony' + text '@tony' → hard-deny holds; tony is NEVER a hey target", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { calls, spawn } = spawnSpy();
    const res = await post({ room: "r", to: "eq3", text: "@tony ping", from: "tony" }, spawn);
    expect(((await res.json()) as { to: string }).to).toBe("eq3"); // falls back to lead
    expect(target(calls[0])).toBe("eq3");
    expect(calls.flat()).not.toContain("tony"); // "tony" never appears anywhere in the hey argv
  });

  test("attacker path (BASE vector): raw POST {to:'tony'}, NO @tag → hard-deny holds on the FINAL resolved target too", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { calls, spawn } = spawnSpy();
    // no @ anywhere in text — resolveRoomTag returns null, so `target` = the raw `to` field
    // untouched by the tag-handle deny. The merge-level guard (route.ts, post-merge) must
    // still catch it, proving the deny sits on the FINAL target, not just the @tag path.
    const res = await post({ room: "r", to: "tony", text: "ping with no tag at all", from: "web" }, spawn);
    expect(((await res.json()) as { to: string }).to).toBe("eq3"); // falls back to lead
    expect(target(calls[0])).toBe("eq3");
    expect(calls.flat()).not.toContain("tony"); // "tony" never appears anywhere in the hey argv
  });

  test("attacker path (UNKNOWN-ROOM vector): raw POST to a room with no company → deny still holds, nudge dropped", async () => {
    // findRoomCompany("does-not-exist") → null under caller control. The deny must NOT be
    // gated on `company` (only the companyLead fallback needs one) — else this is a free
    // bypass: skip the guard entirely by targeting a room that was never opened.
    const { calls, spawn } = spawnSpy();
    const res = await post({ room: "does-not-exist", to: "tony", text: "hi", from: "web" }, spawn);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { to: string | null; skipped?: boolean };
    expect(json.to).toBeNull();
    expect(calls).toHaveLength(0); // no lead to redirect to — dropped, never spawned
    expect(calls.flat()).not.toContain("tony");
    // kobo-600: `skipped` was completely unpinned — reviewer measured that removing the
    // field from the response left this exact test (and the whole suite) green. It's the
    // ONLY signal that distinguishes "target denied, no company to fall back to, NOTHING
    // was delivered" from a normal successful send — collapsing it away would make this
    // case silently indistinguishable from a real send at the response-shape level, even
    // though the delivery behavior above (calls.toHaveLength(0)) already proves nothing
    // went out. Pinned on the FIELD explicitly, not just the delivery side-effect, so a
    // future removal/inversion of `skipped` itself is caught here, not just "no crash."
    expect(json.skipped).toBe(true);
  });

  test("unknown-room, non-denied `to` still routes fine (only denied literals are dropped)", async () => {
    const { calls, spawn } = spawnSpy();
    const res = await post({ room: "does-not-exist", to: "eq3", text: "hi", from: "web" }, spawn);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { to: string }).to).toBe("eq3");
    expect(calls).toHaveLength(1);
    expect(target(calls[0])).toBe("eq3");
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

describe("kobo-390: narrow @tag scope to room participants + idempotent invite — POST direct (bypass UI)", () => {
  let dir: string; const prev = process.env.MAW_DATA_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-narrowtag-"));
    process.env.MAW_DATA_DIR = dir;
    _setCompaniesDir(join(dir, "companies"));
    // "patchwork" is a real companyOracle (∈ roomRepliers pre-390) but NEVER a room
    // participant — this is exactly the gap kobo-390 closes.
    saveCompany({ name: "kobo", teams: { core: { lead: "eq3", members: [{ oracle: "eq3", role: "lead" }, { oracle: "patchwork", role: "member" }] } } });
  });
  afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; _setCompaniesDir(origCompaniesDir); rmSync(dir, { recursive: true, force: true }); });

  const openR = (b: unknown) => handleRoomOpenRequest(new Request("http://x/api/room/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const send = (b: unknown, spawn: (a: string[]) => { exited: Promise<number> }) =>
    handleRoomSendRequest(new Request("http://x/api/room/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), spawn);
  const inviteReq = (b: unknown, spawn: (a: string[]) => { exited: Promise<number> }) =>
    handleRoomInviteRequest(new Request("http://x/api/room/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), spawn);
  const spawnSpy = () => { const calls: string[][] = []; return { calls, spawn: (a: string[]) => { calls.push(a); return { exited: Promise.resolve(0) }; } }; };
  const target = (argv: string[]) => argv[argv.length - 2];

  test("AC1 — @companyOracle who is NOT a room participant → NOT routed, falls back to lead", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { calls, spawn } = spawnSpy();
    const res = await send({ room: "r", to: "eq3", text: "@patchwork can you help", from: "web" }, spawn);
    expect(((await res.json()) as { to: string }).to).toBe("eq3"); // surfaced fallback, not "patchwork"
    expect(target(calls[0])).toBe("eq3"); // real hey target is the lead, NOT patchwork
  });

  test("AC2 — @participant IS routed once invited", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { spawn: inviteSpawn } = spawnSpy();
    await inviteReq({ company: "kobo", room: "r", oracle: "patchwork" }, inviteSpawn);
    const { calls, spawn } = spawnSpy();
    const res = await send({ room: "r", to: "eq3", text: "@patchwork can you help", from: "web" }, spawn);
    expect(((await res.json()) as { to: string }).to).toBe("patchwork");
    expect(target(calls[0])).toBe("patchwork");
  });

  test("AC3 — invite writes a REAL participant (artifact-verified, not UI)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { spawn } = spawnSpy();
    const res = await inviteReq({ company: "kobo", room: "r", oracle: "patchwork" }, spawn);
    expect(res.status).toBe(200);
    expect(readRoom("kobo", "r")!.participants).toContain("patchwork");
  });

  test("AC4 — invite is IDEMPOTENT: re-inviting an existing participant fires NO hey", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const { calls, spawn } = spawnSpy();
    const first = await inviteReq({ company: "kobo", room: "r", oracle: "patchwork" }, spawn);
    expect(first.status).toBe(200);
    expect(calls).toHaveLength(1); // first invite: one notify hey
    const second = await inviteReq({ company: "kobo", room: "r", oracle: "patchwork" }, spawn);
    expect(second.status).toBe(200); // still succeeds (idempotent write)
    expect(calls).toHaveLength(1); // NO second hey — re-invite is a silent no-op notify-wise
    expect(readRoom("kobo", "r")!.participants).toEqual(["patchwork"]); // no duplicate either
  });

  test("AC5 — kobo-385/386 regression, 3 vectors, still hold under the narrowed predicate", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const v1 = spawnSpy(); // TAG vector
    const r1 = await send({ room: "r", to: "eq3", text: "@tony ping", from: "tony" }, v1.spawn);
    expect(((await r1.json()) as { to: string }).to).toBe("eq3");
    expect(v1.calls.flat()).not.toContain("tony");

    const v2 = spawnSpy(); // BASE vector
    const r2 = await send({ room: "r", to: "tony", text: "no tag at all", from: "web" }, v2.spawn);
    expect(((await r2.json()) as { to: string }).to).toBe("eq3");
    expect(v2.calls.flat()).not.toContain("tony");

    const v3 = spawnSpy(); // NULL-COMPANY vector
    const r3 = await send({ room: "does-not-exist", to: "tony", text: "hi", from: "web" }, v3.spawn);
    expect(((await r3.json()) as { to: string | null }).to).toBeNull();
    expect(v3.calls).toHaveLength(0);
    expect(v3.calls.flat()).not.toContain("tony");
  });
});

// kobo-495 — defaultSpawn (the real `maw` subprocess path every test above bypasses
// via an injected fake) must surface a real failure, not swallow it. Exercised with a
// REAL local `maw` subprocess and a REAL non-zero exit (an unrecognized verb — this
// never reaches delivery/dispatch, no fleet traffic, safe) rather than asserting on
// source text or "the option was passed" (front's explicit acceptance bar for this card).
//
// Lifted verbatim from %10's closed PR #334 (fix/kobo-495-cross-company-head-lane) —
// credited in kobo-506's PR body. That branch was closed for reasons unrelated to this
// half's quality (it bundled an unrelated cross-company fix now split into kobo-504);
// this test and the defaultSpawn rewrite above it are his work, reused rather than
// reimplemented per kobo-481's "one place" rule.
describe("defaultSpawn surfaces a real subprocess failure (kobo-495, sibling of kobo-481)", () => {
  let errSpy: { calls: unknown[][]; restore: () => void };
  function spyConsoleError() {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { calls.push(args); };
    return { calls, restore: () => { console.error = original; } };
  }
  beforeEach(() => { errSpy = spyConsoleError(); });
  afterEach(() => { errSpy.restore(); });

  test("a real failing `maw` invocation gets logged with real captured stderr", async () => {
    const proc = defaultSpawn(["nonexistent-verb-kobo-495"]);
    const code = await proc.exited;
    expect(code).not.toBe(0);
    // watchHeySpawnForFailure is fire-and-forget (`void`) — give its own await-chain
    // a tick to finish logging after the same exit the test just observed.
    await new Promise((r) => setTimeout(r, 50));
    expect(errSpy.calls).toHaveLength(1);
    const printed = String(errSpy.calls[0][0]);
    expect(printed).toContain("nonexistent-verb-kobo-495");
    expect(printed).toContain("unknown command");
  });

  test("a real successful `maw` invocation adds no noise", async () => {
    const proc = defaultSpawn(["--version"]);
    const code = await proc.exited;
    expect(code).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(errSpy.calls).toHaveLength(0);
  });
});

// kobo-506 — the gap %10's fix (above) didn't close: even with the failure now LOGGED
// server-side, handleRoomSendRequest itself still discarded the exit code (`void
// proc.exited`) and told the HTTP caller ok:true unconditionally. This is the half that
// makes the failure reach the person who actually needs to know — the human at the web
// room — not just a server console. NOT a fix for the room being silent (that was the
// cross-company gate, kobo-504/#337, unrelated) — this only makes a failed nudge LOUD.
describe("kobo-506: a failed nudge reaches the HTTP caller, not just the server log", () => {
  let dir: string; const prev = process.env.MAW_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-roomnudge-")); process.env.MAW_DATA_DIR = dir; seedCompanies(dir, { kobo: "eq3" }); });
  afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; _setCompaniesDir(origCompaniesDir); rmSync(dir, { recursive: true, force: true }); });

  const openR = (b: unknown) => handleRoomOpenRequest(new Request("http://x/api/room/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const send = (b: unknown, spawn: (a: string[]) => { exited: Promise<number> }, nudgeTimeoutMs?: number) =>
    handleRoomSendRequest(new Request("http://x/api/room/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), spawn, nudgeTimeoutMs);

  test("nudge exits non-zero → response carries notified:false + the exit code, ok stays true", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const spawn = () => ({ exited: Promise.resolve(1) });
    const res = await send({ room: "r", to: "eq3", text: "urgent turn", from: "web" }, spawn);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; notified?: boolean; notifyError?: string };
    expect(body.ok).toBe(true); // NOT flipped — the turn IS saved, see next assertion
    expect(body.notified).toBe(false);
    expect(body.notifyError).toContain("1");
  });

  test("nudge exits non-zero → the turn is STILL persisted (not lost, kobo-249 decoupled-persist)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const spawn = () => ({ exited: Promise.resolve(1) });
    await send({ room: "r", to: "eq3", text: "must survive a failed nudge", from: "web" }, spawn);
    const room = readRoom("kobo", "r")!;
    expect(room.messages).toHaveLength(1);
    expect(room.messages[0]).toMatchObject({ from: "web", text: "must survive a failed nudge" });
  });

  test("nudge exits 0 → unchanged happy path, no notified field at all (no regression)", async () => {
    const spawn = () => ({ exited: Promise.resolve(0) });
    const res = await send({ room: "r", to: "eq3", text: "fine turn", from: "web" }, spawn);
    const body = (await res.json()) as { ok: boolean; notified?: boolean };
    expect(body.ok).toBe(true);
    expect(body.notified).toBeUndefined();
  });

  test("spawn() itself throwing synchronously still hits the pre-existing catch — ok:false 500, untouched by this fix", async () => {
    // A synchronous throw from spawn(...) (still inside the try) is the shape the
    // pre-existing `catch (e)` at the bottom of the function exists for — this fix only
    // touches the AFTER-spawn-resolves path (await proc.exited), so this must still land
    // exactly where it always did, not get swallowed into the new notified:false shape.
    const throwingSpawn = () => { throw new Error("spawn itself failed"); };
    const res = await send({ room: "r", to: "eq3", text: "hi", from: "web" }, throwingSpawn);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error?: string; notified?: boolean };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("spawn itself failed");
    expect(body.notified).toBeUndefined(); // the new field never appears on this path
  });

  // kobo-506 request-change (%11, verified real hands-on: a real never-exiting spawn
  // left the response PENDING at 1500ms, disabled 'send' with no error on screen — the
  // exact silent-failure shape this card exists to kill, arriving through the new door
  // this fix itself opened). A hung spawn must not drag the HTTP response with it —
  // race against a ceiling and answer notified:false rather than hang forever.
  test("nudge that NEVER exits → response returns within the ceiling with notified:false, not a hang", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const hangingSpawn = () => ({ exited: new Promise<number>(() => { /* never resolves */ }) });
    const start = Date.now();
    const res = await send({ room: "r", to: "eq3", text: "hangs forever", from: "web" }, hangingSpawn, 20); // 20ms ceiling — real default is 5000ms, injected small so this test stays fast
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(500); // returned promptly, not hung on the never-resolving promise
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; notified?: boolean; notifyError?: string };
    expect(body.ok).toBe(true); // turn still saved
    expect(body.notified).toBe(false);
    expect(body.notifyError).toContain("20ms");
  });

  test("nudge that NEVER exits → the turn is STILL persisted (same guarantee as the exit-1 case)", async () => {
    await openR({ company: "kobo", room: "r", topic: "t" });
    const hangingSpawn = () => ({ exited: new Promise<number>(() => { /* never resolves */ }) });
    await send({ room: "r", to: "eq3", text: "hangs but saved", from: "web" }, hangingSpawn, 20);
    const room = readRoom("kobo", "r")!;
    expect(room.messages).toHaveLength(1);
    expect(room.messages[0]).toMatchObject({ from: "web", text: "hangs but saved" });
  });
});
