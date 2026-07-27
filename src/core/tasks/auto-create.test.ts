import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  autoCaptureCardMentions,
  autoCreateFromDispatch,
  parseRepo,
  parseRequestDispatch,
  targetOracle,
} from "./auto-create";
import { listTasks } from "./store";
import { _setCompaniesDir, COMPANIES_DIR, saveCompany, type Company } from "../../vendor/mpr-plugins/company/company-helpers";
import { companyScopeViolation } from "../worklog/company-scope";

const dir = mkdtempSync(join(tmpdir(), "maw-autocreate-"));
const prev = process.env.MAW_DATA_DIR;
const COMPANY = () => "pgw"; // stub company resolver — sender always in pgw

beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies"), { recursive: true, force: true }); });

const create = (msg: string, target: string, sender: string | null = "eq3") =>
  autoCreateFromDispatch(msg, target, () => sender, { resolveCompany: sender ? COMPANY : () => null });

describe("parseRequestDispatch", () => {
  test("extracts id + first-line title", () => {
    expect(parseRequestDispatch("[request:foo-1] do bar\nmore detail\nlines")).toEqual({
      requestId: "foo-1",
      title: "do bar",
    });
  });
  test("trims title to 80 chars", () => {
    const long = "x".repeat(200);
    expect(parseRequestDispatch(`[request:foo-2] ${long}`)!.title.length).toBe(80);
  });
  test("skips replies (re:[request:…]) and normal/broadcast messages", () => {
    expect(parseRequestDispatch("re:[request:foo-1] done")).toBeNull();
    expect(parseRequestDispatch("just a normal message")).toBeNull();
    expect(parseRequestDispatch("[m5:eq3] 🔧 deploy broadcast")).toBeNull(); // not a [request:
  });
  test("requires the tag to lead the message", () => {
    expect(parseRequestDispatch("blah [request:foo-1] not at start")).toBeNull();
  });
});

describe("targetOracle / parseRepo", () => {
  test("strips node/session prefix + -oracle suffix", () => {
    expect(targetOracle("patchwork")).toBe("patchwork");
    expect(targetOracle("m5:patchwork")).toBe("patchwork");
    expect(targetOracle("08-mawjs:neo-oracle")).toBe("neo");
  });
  test("strips pane index + session prefix (kobo-169 provenance)", () => {
    expect(targetOracle("13-patchwork:0.0")).toBe("patchwork"); // pane index → session token holds name
    expect(targetOracle("05-eq3:eq3-oracle.0")).toBe("eq3"); // -oracle + pane index
    expect(targetOracle("eq3")).toBe("eq3"); // bare name unchanged
    expect(targetOracle("phaith:01-hojo")).toBe("hojo"); // node:oracle, best-effort leading-prefix strip
  });
  test("parseRepo pulls target_repo when present", () => {
    expect(parseRepo("[request:x] do\ntarget_repo: meganechan/maw-js\n...")).toBe("meganechan/maw-js");
    expect(parseRepo("[request:x] no repo here")).toBeUndefined();
  });
});

describe("autoCreateFromDispatch", () => {
  test("creates an in-progress card: by=sender, assignee=target", () => {
    const t = create("[request:foo-1] do bar\nbody", "m5:patchwork")!;
    expect(t).not.toBeNull();
    expect(t.by).toBe("eq3");
    expect(t.assignee).toBe("patchwork");
    expect(t.state).toBe("in-progress");
    expect(t.title).toBe("do bar");
    expect(t.requestId).toBe("foo-1");
    expect(listTasks("pgw").length).toBe(1);
  });

  test("captures target_repo when present", () => {
    const t = create("[request:foo-9] ship it\ntarget_repo: meganechan/maw-js", "patchwork")!;
    expect(t.repo).toBe("meganechan/maw-js");
  });

  test("idempotent by requestId — re-send creates no duplicate", () => {
    create("[request:dup-1] first send", "patchwork");
    const again = create("[request:dup-1] first send", "patchwork");
    expect(again).toBeNull();
    expect(listTasks("pgw").filter((t) => t.requestId === "dup-1").length).toBe(1);
  });

  test("does NOT create for replies / normal / broadcast", () => {
    expect(create("re:[request:foo-1] thanks", "patchwork")).toBeNull();
    expect(create("normal hey message", "patchwork")).toBeNull();
    expect(create("[m5:eq3] broadcast announce", "patchwork")).toBeNull();
    expect(listTasks("pgw")).toEqual([]);
  });

  test("skips when sender has no company (no card to scope)", () => {
    const t = autoCreateFromDispatch("[request:x-1] do", "patchwork", () => "eq3", { resolveCompany: () => null });
    expect(t).toBeNull();
  });

  test("skips when sender cannot be resolved", () => {
    expect(create("[request:x-1] do", "patchwork", null)).toBeNull();
  });

  // kobo-216 (Card B of kobo-166) — a multi-company sender resolves via the strict
  // resolver, which throws "ambiguous …". autoCreate must PROPAGATE (not swallow) the
  // throw, BEFORE any addTask/idempotency work — route-comm's try/catch then refuses the
  // auto-create without minting a wrong-company duplicate card. The default resolver IS
  // companyOfOracleStrict; here we inject its throw to pin the propagation contract.
  test("propagates the ambiguity throw from a multi-company sender (no card minted)", () => {
    const ambiguous = () => { throw new Error("ambiguous: eq3 belongs to [eq3, kobo] — specify --company"); };
    expect(() =>
      autoCreateFromDispatch("[request:amb-1] do", "patchwork", () => "eq3", { resolveCompany: ambiguous }),
    ).toThrow(/ambiguous: eq3 belongs to \[eq3, kobo\]/);
    expect(listTasks("pgw").filter((t) => t.requestId === "amb-1")).toEqual([]); // nothing created
  });
});

describe("autoCaptureCardMentions", () => {
  // per-id state, default "in-progress" (open) so existing tests keep behaving unchanged
  const defaultCardState = (): Map<string, string> => new Map([
    ["kobo-1", "in-progress"],
    ["kobo-2", "in-progress"],
    ["kob-payment-5", "in-progress"],
    ["eq3-11", "in-progress"],
  ]);
  let cardState = defaultCardState();
  const noted: { company: string; id: string; by: string; text: string; captured?: boolean }[] = [];
  let scopeViolationReturns: string | null = null; // kobo-424 (D) — null = sender is a member, allow
  const deps = {
    readCard: (_c: string, id: string) => (cardState.has(id) ? ({ id, state: cardState.get(id) } as never) : null),
    note: (company: string, id: string, by: string, text: string, opts?: { captured?: boolean }) => {
      noted.push({ company, id, by, text, captured: opts?.captured });
      return {} as never;
    },
    scopeViolation: (_company: string, _sender: string) => scopeViolationReturns,
  };
  beforeEach(() => { noted.length = 0; scopeViolationReturns = null; cardState = defaultCardState(); });

  const cap = (msg: string, target = "m5:patchwork", sender: string | null = "eq3") =>
    autoCaptureCardMentions(msg, target, () => sender, deps);

  test("captures an existing card ref as a note by sender, tagged [via hey→target]", () => {
    expect(cap("pls look at kobo-1 today")).toEqual(["kobo-1"]);
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({ company: "kobo", id: "kobo-1", by: "eq3" });
    expect(noted[0].text).toBe("[via hey→patchwork] pls look at kobo-1 today");
    // kobo-229: captured notes are tagged so noteTask skips auto-advance (mention ≠ work)
    expect(noted[0].captured).toBe(true);
  });
  test("dedups a repeated id, captures multiple distinct cards", () => {
    expect(cap("kobo-1 and kobo-1 and kobo-2")).toEqual(["kobo-1", "kobo-2"]);
    expect(noted).toHaveLength(2);
  });
  test("company prefix may contain hyphens (<company>-<n>)", () => {
    expect(cap("bug in kob-payment-5")).toEqual(["kob-payment-5"]);
    expect(noted[0].company).toBe("kob-payment");
  });
  test("company name ending in a digit is captured (eq3-11, not dropped)", () => {
    expect(cap("look at eq3-11")).toEqual(["eq3-11"]);
    expect(noted[0].company).toBe("eq3");
  });
  test("skips unknown / non-card tokens silently (kobo-999, utf-8)", () => {
    expect(cap("what about kobo-999 or utf-8 encoding")).toEqual([]);
    expect(noted).toEqual([]);
  });
  test("no card ref → no-op, sender never resolved", () => {
    let resolved = false;
    autoCaptureCardMentions("just a normal message", "patchwork", () => { resolved = true; return "eq3"; }, deps);
    expect(resolved).toBe(false);
  });
  test("skips when sender cannot be resolved", () => {
    expect(cap("look at kobo-1", "patchwork", null)).toEqual([]);
    expect(noted).toEqual([]);
  });
  test("echo guard: a message already tagged [via hey] is never re-captured", () => {
    expect(cap("[via hey→patchwork] pls look at kobo-1")).toEqual([]);
    expect(noted).toEqual([]);
  });

  // kobo-424 (A) — 92.3% of auto-notes were landing on already-closed cards;
  // isOnBoard-style state check at the write point, not just existence.
  describe("(A) closed cards don't collect auto-notes", () => {
    test("skips a done card", () => {
      cardState.set("kobo-1", "done");
      expect(cap("pls look at kobo-1")).toEqual([]);
      expect(noted).toEqual([]);
    });
    test("skips a rejected card", () => {
      cardState.set("kobo-1", "rejected");
      expect(cap("pls look at kobo-1")).toEqual([]);
      expect(noted).toEqual([]);
    });
    test("still captures an open card — no regression (backlog/todo/in-progress/review/etc)", () => {
      cardState.set("kobo-1", "review");
      expect(cap("pls look at kobo-1")).toEqual(["kobo-1"]);
      expect(noted).toHaveLength(1);
    });
    test("reopened card (state flipped back off-terminal) accepts notes again — not a permanent stamp", () => {
      cardState.set("kobo-1", "done");
      expect(cap("pls look at kobo-1")).toEqual([]);
      cardState.set("kobo-1", "todo"); // reopened
      expect(cap("pls look at kobo-1 again")).toEqual(["kobo-1"]);
    });
    test("mixed message: closed card filtered per-ref, open card in the same message still captured", () => {
      cardState.set("kobo-1", "done");
      expect(cap("kobo-1 is closed but kobo-2 needs kobo-2")).toEqual(["kobo-2"]);
      expect(noted).toHaveLength(1);
      expect(noted[0].id).toBe("kobo-2");
    });
  });

  // kobo-424 (D) — sender must be a member of the mentioned card's own company;
  // 70 real cross-company auto-notes landed because company came from a bare
  // regex match on the message with no membership check against the sender.
  describe("(D) no cross-company auto-note", () => {
    test("refuses when sender is not a member of the card's company", () => {
      scopeViolationReturns = 'refuse: "eq3" is not in company "kobo" — cross-company dispatch is blocked (kobo-341).';
      expect(cap("look at kobo-1", "m5:patchwork", "eq3")).toEqual([]);
      expect(noted).toEqual([]);
    });
    test("still captures when sender IS a member (no regression)", () => {
      scopeViolationReturns = null;
      expect(cap("look at kobo-1", "m5:patchwork", "eq3")).toEqual(["kobo-1"]);
      expect(noted).toHaveLength(1);
    });

    // The tests above stub `scopeViolation` — they prove the call site is wired,
    // not that cross-company writing is actually blocked (a stub that ignores its
    // own arguments, e.g. an accidental parameter-order swap at the call site,
    // would pass every one of them). This one omits the stub entirely so
    // `deps.scopeViolation ?? companyScopeViolation` falls through to the REAL
    // helper, against a genuinely REGISTERED company pair.
    //
    // pgw is the fixture that matters, not kobo: company-scope.ts:138 allows an
    // UNREGISTERED company through (members.length === 0 → null → allow, a
    // documented kobo-341 tradeoff) — a made-up company name would silently test
    // nothing. pgw is real and registered here with members that do NOT include
    // patchwork/eq3, so the refusal is genuine, not a fixture artifact.
    describe("real companyScopeViolation (no stub) — genuine cross-company pair", () => {
      const ORIGINAL_COMPANIES_DIR = COMPANIES_DIR;
      let companiesTmp: string;

      beforeEach(() => {
        companiesTmp = mkdtempSync(join(tmpdir(), "kobo424-companies-"));
        _setCompaniesDir(companiesTmp);
        const pgw: Company = {
          name: "pgw",
          manager: "thawanban",
          teams: { core: { lead: "nai", members: [{ oracle: "nai", role: "lead" }, { oracle: "lek", role: "dev" }] } },
        };
        const kobo: Company = {
          name: "kobo",
          manager: "eq3",
          teams: { dev: { lead: "patchwork", members: [{ oracle: "patchwork", role: "dev" }] } },
        };
        saveCompany(pgw);
        saveCompany(kobo);
        cardState.set("pgw-1", "in-progress");
        cardState.set("kobo-1", "in-progress");
      });
      afterEach(() => {
        _setCompaniesDir(ORIGINAL_COMPANIES_DIR);
        try { rmSync(companiesTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
      });

      const capReal = (msg: string, sender: string) =>
        autoCaptureCardMentions(msg, "m5:patchwork", () => sender, { readCard: deps.readCard, note: deps.note });

      test("refuses a real cross-company write: patchwork is not a pgw member", () => {
        // pin the actual refusal string first — proves the fixture is genuinely
        // blocked for the documented reason, not some other falsy/truthy coincidence
        expect(companyScopeViolation("pgw", "patchwork")).toContain("cross-company dispatch is blocked");
        expect(capReal("look at pgw-1", "patchwork")).toEqual([]);
        expect(noted).toEqual([]);
      });
      test("still allows same-company (kobo+patchwork) against the real helper — no regression", () => {
        expect(capReal("look at kobo-1", "patchwork")).toEqual(["kobo-1"]);
        expect(noted).toHaveLength(1);
      });
    });
  });
});
