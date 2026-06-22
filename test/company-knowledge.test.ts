import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _setCompaniesDir,
  createCompany, addDepartment, assignMember, kbTagFor,
} from "../src/vendor/mpr-plugins/company/company-helpers";
import {
  kbLearnPayload, kbTagSearchUrl, kbHybridSearchUrl, mergeDeptResults, resolveKbUrl,
  resolveLead, planShareTargets, planSyncTargets,
  deptLearn, deptKnowledge, deptShare, deptSync,
  type FetchLike, type KbSearchResult, type ClaudeJson,
} from "../src/vendor/mpr-plugins/company/company-knowledge";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-company-knowledge-"));
  _setCompaniesDir(dir);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ─── pure: resolveKbUrl ──────────────────────────────────────────────────────

describe("resolveKbUrl", () => {
  const REMOTE = "http://10.66.66.26:47778";
  const root = (url: string): ClaudeJson => ({
    mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: url } } },
  });
  const perProject = (url: string): ClaudeJson => ({
    projects: { "/some/path": { mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: url } } } } },
  });

  test("(a) env.ORACLE_REMOTE_URL wins over everything", () => {
    expect(
      resolveKbUrl({ env: { ORACLE_REMOTE_URL: REMOTE, ARRA_URL: "http://other" }, claudeJson: root("http://json") }),
    ).toBe(REMOTE);
  });

  test("(b) env.ARRA_URL is next when ORACLE_REMOTE_URL absent", () => {
    expect(
      resolveKbUrl({ env: { ARRA_URL: "http://manual" }, claudeJson: root("http://json") }),
    ).toBe("http://manual");
  });

  test("(c) claude.json ROOT mcpServers used when env absent", () => {
    expect(resolveKbUrl({ env: {}, claudeJson: root(REMOTE) })).toBe(REMOTE);
  });

  test("(d) per-project fallback when root absent", () => {
    expect(resolveKbUrl({ env: {}, claudeJson: perProject(REMOTE) })).toBe(REMOTE);
  });

  test("(d) first non-empty per-project hit wins", () => {
    const cj: ClaudeJson = {
      projects: {
        "/a": { mcpServers: { "arra-oracle": { env: {} } } },
        "/b": { mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: REMOTE } } } },
      },
    };
    expect(resolveKbUrl({ env: {}, claudeJson: cj })).toBe(REMOTE);
  });

  test("(e) localhost fallback when claude.json is null", () => {
    expect(resolveKbUrl({ env: {}, claudeJson: null })).toBe("http://localhost:47778");
  });

  test("(e) localhost fallback honors ORACLE_PORT", () => {
    expect(resolveKbUrl({ env: { ORACLE_PORT: "9999" }, claudeJson: null })).toBe("http://localhost:9999");
  });

  test("(e) localhost fallback when claude.json lacks the keys", () => {
    expect(resolveKbUrl({ env: {}, claudeJson: { mcpServers: {} } })).toBe("http://localhost:47778");
    expect(resolveKbUrl({ env: {}, claudeJson: {} })).toBe("http://localhost:47778");
  });

  test("(f) precedence: root claude.json beats per-project", () => {
    const cj: ClaudeJson = {
      mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: "http://root" } } },
      projects: { "/p": { mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: "http://proj" } } } } },
    };
    expect(resolveKbUrl({ env: {}, claudeJson: cj })).toBe("http://root");
  });

  test("(f) full precedence order ORACLE_REMOTE_URL > ARRA_URL > json > localhost", () => {
    const cj = root("http://json");
    expect(resolveKbUrl({ env: { ORACLE_REMOTE_URL: "http://exp", ARRA_URL: "http://man" }, claudeJson: cj })).toBe("http://exp");
    expect(resolveKbUrl({ env: { ARRA_URL: "http://man" }, claudeJson: cj })).toBe("http://man");
    expect(resolveKbUrl({ env: {}, claudeJson: cj })).toBe("http://json");
    expect(resolveKbUrl({ env: {}, claudeJson: null })).toBe("http://localhost:47778");
  });

  test("blank/whitespace values fall through, not treated as set", () => {
    expect(
      resolveKbUrl({ env: { ORACLE_REMOTE_URL: "   ", ARRA_URL: "" }, claudeJson: root(REMOTE) }),
    ).toBe(REMOTE);
    expect(resolveKbUrl({ env: {}, claudeJson: root("  ") })).toBe("http://localhost:47778");
  });
});

// ─── pure: kbLearnPayload ────────────────────────────────────────────────────

describe("kbLearnPayload", () => {
  test("tags concept AND embeds tag inline in content", () => {
    const p = kbLearnPayload("kob", "payment", "use idempotency keys for retries");
    const tag = kbTagFor("kob", "payment"); // dept:kob:payment
    expect(p.concepts).toEqual([tag]);
    expect(p.content.startsWith(`[${tag}] `)).toBe(true);
    expect(p.content).toContain("use idempotency keys for retries");
    expect(p.type).toBe("learning");
    expect(p.source).toBe("maw dept learn:kob/payment");
  });

  test("pattern is first-line summary of the knowledge", () => {
    const p = kbLearnPayload("kob", "payment", "first line summary\nmore detail here");
    expect(p.pattern).toBe("first line summary");
  });

  test("leading-blank knowledge: first non-empty line after trim is the pattern", () => {
    const p = kbLearnPayload("kob", "payment", "\nbody only");
    expect(p.pattern).toBe("body only");
  });

  test("pattern falls back to dept tag when knowledge is whitespace-only", () => {
    const tag = kbTagFor("kob", "payment");
    const p = kbLearnPayload("kob", "payment", "   ");
    expect(p.pattern).toBe(tag);
  });

  test("long first line is truncated for pattern but full in content", () => {
    const long = "x".repeat(200);
    const p = kbLearnPayload("kob", "payment", long);
    expect(p.pattern.length).toBeLessThanOrEqual(120);
    expect(p.pattern.endsWith("...")).toBe(true);
    expect(p.content).toContain(long);
  });
});

// ─── pure: kbTagSearchUrl / kbHybridSearchUrl ────────────────────────────────

describe("kbTagSearchUrl", () => {
  const tag = "dept:kob:payment";

  test("q is the literal dept tag, mode=fts, default limit=10", () => {
    const url = kbTagSearchUrl("http://localhost:47778", tag);
    expect(url).toContain(`q=${encodeURIComponent(tag)}`);
    expect(url).toContain("limit=10");
    expect(url).toContain("mode=fts");
    expect(url).not.toContain("mode=hybrid");
  });

  test("custom limit is honoured", () => {
    expect(kbTagSearchUrl("http://b", tag, 25)).toContain("limit=25");
  });

  test("tag is url-encoded (colons not raw)", () => {
    const url = kbTagSearchUrl("http://b", tag);
    expect(url).toContain(encodeURIComponent(tag));
  });
});

describe("kbHybridSearchUrl", () => {
  test("q is the user query (NOT the tag), mode=hybrid, default limit=10", () => {
    const url = kbHybridSearchUrl("http://localhost:47778", "retry logic");
    expect(url).toContain(`q=${encodeURIComponent("retry logic")}`);
    expect(url).toContain("limit=10");
    expect(url).toContain("mode=hybrid");
    expect(url).not.toContain("mode=fts");
  });

  test("custom limit is honoured", () => {
    expect(kbHybridSearchUrl("http://b", "q", 5)).toContain("limit=5");
  });

  test("encodes special characters in query", () => {
    const url = kbHybridSearchUrl("http://b", "a&b=c");
    expect(url).toContain(encodeURIComponent("a&b=c"));
    expect(url).not.toContain("q=a&b=c"); // raw form must not leak
  });
});

// ─── pure: mergeDeptResults ──────────────────────────────────────────────────

describe("mergeDeptResults", () => {
  const mk = (source_file: string, content = source_file, score = 1): KbSearchResult =>
    ({ content, type: "learning", source_file, score });

  test("dept (source-1) entries come first, then hybrid neighbours", () => {
    const tagResults = [mk("d1"), mk("d2")];
    const hybridResults = [mk("h1"), mk("h2")];
    const merged = mergeDeptResults(tagResults, hybridResults);
    expect(merged.map((r) => r.source_file)).toEqual(["d1", "d2", "h1", "h2"]);
  });

  test("dedup by source_file: an entry in BOTH sources appears once (source-1 position)", () => {
    const tagResults = [mk("d1"), mk("shared")];
    const hybridResults = [mk("shared"), mk("h1")];
    const merged = mergeDeptResults(tagResults, hybridResults);
    expect(merged.map((r) => r.source_file)).toEqual(["d1", "shared", "h1"]);
  });

  test("dedup falls back to content when source_file is absent", () => {
    const noFile = (content: string): KbSearchResult => ({ content, type: "x", source_file: "", score: 1 });
    const merged = mergeDeptResults([noFile("same")], [noFile("same"), noFile("other")]);
    expect(merged.map((r) => r.content)).toEqual(["same", "other"]);
  });

  test("neither side is dropped (disjoint sets fully preserved)", () => {
    const merged = mergeDeptResults([mk("d1")], [mk("h1")]);
    expect(merged).toHaveLength(2);
  });
});

// ─── pure: resolveLead / planShareTargets / planSyncTargets ──────────────────

describe("target planning", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment", { lead: "pay-lead" });
    assignMember("kob", "payment", "pay-dev-1", "dev");
    assignMember("kob", "payment", "pay-dev-2", "dev");
  });

  test("resolveLead returns the lead when set", () => {
    expect(resolveLead("kob", "payment")).toBe("pay-lead");
  });

  test("resolveLead returns null when no lead", () => {
    addDepartment("kob", "ops");
    expect(resolveLead("kob", "ops")).toBeNull();
  });

  test("resolveLead returns null for unknown company/dept", () => {
    expect(resolveLead("ghost", "x")).toBeNull();
  });

  test("planShareTargets returns ALL members (including lead)", () => {
    const targets = planShareTargets("kob", "payment").map((m) => m.oracle).sort();
    expect(targets).toEqual(["pay-dev-1", "pay-dev-2", "pay-lead"]);
  });

  test("planSyncTargets EXCLUDES the lead (lead is the source)", () => {
    const targets = planSyncTargets("kob", "payment").map((m) => m.oracle).sort();
    expect(targets).toEqual(["pay-dev-1", "pay-dev-2"]);
    expect(targets).not.toContain("pay-lead");
  });
});

// ─── async: deptLearn (injected fetch) ───────────────────────────────────────

describe("deptLearn (injected fetch)", () => {
  test("POSTs to /api/learn with the dept-tagged payload", async () => {
    let captured: { url: string; init: any } | null = null;
    const fakeFetch: FetchLike = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const res = await deptLearn("kob", "payment", "use idempotency keys", {
      fetch: fakeFetch,
      url: "http://kb",
    });
    expect(res.ok).toBe(true);
    expect(captured!.url).toBe("http://kb/api/learn");
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(captured!.init.body);
    expect(body.concepts).toEqual(["dept:kob:payment"]);
    expect(body.content).toContain("[dept:kob:payment]");
    expect(body.content).toContain("use idempotency keys");
  });

  test("non-2xx → graceful error, no throw", async () => {
    const fakeFetch: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const res = await deptLearn("kob", "payment", "k", { fetch: fakeFetch, url: "http://kb" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("503");
  });

  test("thrown fetch (KB unreachable) → graceful error, no throw", async () => {
    const fakeFetch: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    const res = await deptLearn("kob", "payment", "k", { fetch: fakeFetch, url: "http://kb" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("KB unreachable");
    expect(res.message).toContain("http://kb");
  });
});

// ─── async: deptKnowledge (injected fetch) ───────────────────────────────────

describe("deptKnowledge (injected fetch) — two-source merge", () => {
  const TAG = "dept:kob:payment";
  // Route a fake fetch by which mode the URL carries (fts = source 1, hybrid = source 2).
  type ByMode = { fts?: KbSearchResult[]; hybrid?: KbSearchResult[]; ftsThrows?: boolean; hybridThrows?: boolean; ftsStatus?: number };
  const routed = (cfg: ByMode): { fetch: FetchLike; urls: string[] } => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      const isHybrid = url.includes("mode=hybrid");
      if (isHybrid && cfg.hybridThrows) throw new Error("hybrid down");
      if (!isHybrid && cfg.ftsThrows) throw new Error("fts down");
      if (!isHybrid && cfg.ftsStatus && cfg.ftsStatus >= 400) {
        return { ok: false, status: cfg.ftsStatus, json: async () => ({}) };
      }
      const results = isHybrid ? (cfg.hybrid ?? []) : (cfg.fts ?? []);
      return { ok: true, status: 200, json: async () => ({ results }) };
    };
    return { fetch, urls };
  };
  const dept = (sf: string): KbSearchResult => ({ content: `[${TAG}] ${sf}`, type: "learning", source_file: sf, score: 0.03 });
  const neighbour = (sf: string): KbSearchResult => ({ content: `unrelated ${sf}`, type: "learning", source_file: sf, score: 0.9 });

  // THE KEY REGRESSION GUARD: a tagged dept entry that is NOT in the hybrid
  // window must STILL come back (source 1 guarantees it). This is the case #22
  // failed — hybrid sank the dept entries below top-10, returning 0 of them.
  test("tagged entry OUTSIDE the hybrid window is still returned (source-1 guarantee)", async () => {
    const { fetch, urls } = routed({
      fts: [dept("d1"), dept("d2")],          // source 1 surfaces the dept's entries
      hybrid: [neighbour("n1"), neighbour("n2")], // source 2: ONLY untagged neighbours
    });
    const res = await deptKnowledge("kob", "payment", "retries", { fetch, url: "http://kb" });
    expect(res.ok).toBe(true);
    const files = res.results.map((r) => r.source_file);
    // dept entries present AND first, neighbours appended
    expect(files).toEqual(["d1", "d2", "n1", "n2"]);
    // both URLs were hit, with the right modes + q
    expect(urls.some((u) => u.includes("mode=fts") && u.includes(encodeURIComponent(TAG)))).toBe(true);
    expect(urls.some((u) => u.includes("mode=hybrid") && u.includes(encodeURIComponent("retries")))).toBe(true);
    // hybrid q must NOT be the tag
    expect(urls.find((u) => u.includes("mode=hybrid"))).not.toContain(encodeURIComponent(TAG));
  });

  test("no-query browse runs ONLY source 1 and returns the dept's entries (not 0, not neighbours)", async () => {
    const { fetch, urls } = routed({ fts: [dept("d1"), dept("d2")], hybrid: [neighbour("should-not-run")] });
    const res = await deptKnowledge("kob", "payment", undefined, { fetch, url: "http://kb" });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.source_file)).toEqual(["d1", "d2"]);
    // hybrid was never queried
    expect(urls.every((u) => u.includes("mode=fts"))).toBe(true);
    expect(urls.some((u) => u.includes("mode=hybrid"))).toBe(false);
  });

  test("dept entry also surfaced by hybrid is not duplicated", async () => {
    const { fetch } = routed({ fts: [dept("d1")], hybrid: [dept("d1"), neighbour("n1")] });
    const res = await deptKnowledge("kob", "payment", "q", { fetch, url: "http://kb" });
    expect(res.results.map((r) => r.source_file)).toEqual(["d1", "n1"]);
  });

  test("message honestly reports dept vs related counts", async () => {
    const { fetch } = routed({ fts: [dept("d1"), dept("d2")], hybrid: [neighbour("n1")] });
    const res = await deptKnowledge("kob", "payment", "q", { fetch, url: "http://kb" });
    expect(res.message).toContain("3 result(s)");
    expect(res.message).toContain("2 in dept");
    expect(res.message).toContain("1 related");
  });

  // ── per-source best-effort ──────────────────────────────────────────────────
  test("source 2 (hybrid) throws → still returns source 1 results, no crash", async () => {
    const { fetch } = routed({ fts: [dept("d1")], hybridThrows: true });
    const res = await deptKnowledge("kob", "payment", "q", { fetch, url: "http://kb" });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.source_file)).toEqual(["d1"]);
  });

  test("source 1 (fts) throws but hybrid ok → still returns hybrid neighbours", async () => {
    const { fetch } = routed({ ftsThrows: true, hybrid: [neighbour("n1")] });
    const res = await deptKnowledge("kob", "payment", "q", { fetch, url: "http://kb" });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.source_file)).toEqual(["n1"]);
  });

  test("source 1 non-2xx but hybrid ok → still returns hybrid neighbours", async () => {
    const { fetch } = routed({ ftsStatus: 500, hybrid: [neighbour("n1")] });
    const res = await deptKnowledge("kob", "payment", "q", { fetch, url: "http://kb" });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.source_file)).toEqual(["n1"]);
  });

  test("BOTH sources throw → graceful 'KB unreachable', empty results", async () => {
    const { fetch } = routed({ ftsThrows: true, hybridThrows: true });
    const res = await deptKnowledge("kob", "payment", "q", { fetch, url: "http://kb" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("KB unreachable");
    expect(res.results).toEqual([]);
  });

  test("no-query browse + source 1 throws → graceful error (no hybrid to fall back on)", async () => {
    const { fetch } = routed({ ftsThrows: true });
    const res = await deptKnowledge("kob", "payment", undefined, { fetch, url: "http://kb" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("KB unreachable");
    expect(res.results).toEqual([]);
  });
});

// ─── async: deptShare / deptSync (injected send/sync, no process spawn) ───────

describe("deptShare (injected send)", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment", { lead: "pay-lead" });
    assignMember("kob", "payment", "pay-dev-1", "dev");
  });

  test("sends to every member, reports per-member ok", async () => {
    const seen: string[] = [];
    const reports = await deptShare("kob", "payment", "ship it", {
      send: async (member) => { seen.push(member); },
    });
    expect(seen.sort()).toEqual(["pay-dev-1", "pay-lead"]);
    expect(reports.every((r) => r.ok)).toBe(true);
  });

  test("one failing send does not abort the rest", async () => {
    const reports = await deptShare("kob", "payment", "msg", {
      send: async (member) => { if (member === "pay-lead") throw new Error("offline"); },
    });
    const byOracle = Object.fromEntries(reports.map((r) => [r.oracle, r]));
    expect(byOracle["pay-lead"].ok).toBe(false);
    expect(byOracle["pay-lead"].detail).toContain("offline");
    expect(byOracle["pay-dev-1"].ok).toBe(true);
  });
});

describe("deptSync (injected sync)", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment", { lead: "pay-lead" });
    assignMember("kob", "payment", "pay-dev-1", "dev");
    assignMember("kob", "payment", "pay-dev-2", "dev");
  });

  test("syncs each non-lead member FROM the lead", async () => {
    const pairs: Array<[string, string]> = [];
    const res = await deptSync("kob", "payment", {
      sync: async (lead, member) => { pairs.push([lead, member]); },
    });
    expect(res.lead).toBe("pay-lead");
    expect(pairs.every(([lead]) => lead === "pay-lead")).toBe(true);
    expect(pairs.map(([, m]) => m).sort()).toEqual(["pay-dev-1", "pay-dev-2"]);
    expect(res.reports.every((r) => r.ok)).toBe(true);
  });

  test("no lead → lead:null, no sync attempted", async () => {
    addDepartment("kob", "ops");
    assignMember("kob", "ops", "ops-1", "dev");
    let called = false;
    const res = await deptSync("kob", "ops", { sync: async () => { called = true; } });
    expect(res.lead).toBeNull();
    expect(called).toBe(false);
  });

  test("a failing member sync is reported, others continue", async () => {
    const res = await deptSync("kob", "payment", {
      sync: async (_lead, member) => { if (member === "pay-dev-1") throw new Error("no repo"); },
    });
    const byOracle = Object.fromEntries(res.reports.map((r) => [r.oracle, r]));
    expect(byOracle["pay-dev-1"].ok).toBe(false);
    expect(byOracle["pay-dev-2"].ok).toBe(true);
  });
});
