import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  autoCreateFromDispatch,
  parseRepo,
  parseRequestDispatch,
  targetOracle,
} from "./auto-create";
import { listTasks } from "./store";

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
