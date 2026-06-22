import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  loadCompany, departmentMembers, kbTagFor,
  type DeptMember,
} from "./company-helpers";

/**
 * Company plugin — Department Knowledge Exchange (spec §4, Phase 2.2).
 *
 *   maw dept learn     <co> <dept> "<knowledge>"   write → KB (muninn), dept-tagged
 *   maw dept knowledge <co> <dept> [<query>]       search KB — dept entries + related (two-source merge)
 *   maw dept share     <co> <dept> "<msg>"         push message to dept members
 *   maw dept sync      <co> <dept>                  soul-sync members FROM the dept lead
 *
 * ── SOFT GROUPING, NOT ACCESS CONTROL ──────────────────────────────────────
 * The `dept:<co>:<dept>` tag is a CONVENIENCE scope for search — it is NOT a
 * permission boundary. There are deliberately NO "is this oracle in the same
 * company?" checks anywhere here. The KB stays family-wide and federation stays
 * open; we only add a tag so a member CAN narrow a search to their department.
 *
 * ── REUSE-ONLY SUBSTRATE ────────────────────────────────────────────────────
 *   - learn / knowledge → talk to the KB (muninn) HTTP server directly. `maw
 *     learn` is a stub (#521), so we POST/GET the KB API the same way the
 *     `dream` plugin does. KB base URL mirrors dream exactly.
 *   - share  → shell out `maw hey <member> "<msg>"` per member (cmdSend calls
 *     process.exit on failure, which would kill the whole CLI mid-fan-out — a
 *     subprocess isolates that, matching the `attach` verb's spawn precedent).
 *   - sync   → wrap the real `cmdSoulSync` primitive (see deptSync for the
 *     verified semantics). No new sync mechanism is invented.
 *
 * The PURE helpers (payload/url builders, filters, target planners) carry the
 * testable logic; the async orchestrators inject their I/O (fetch / send / sync)
 * so they can be unit tested without a live server or spawned process.
 */

// ─── KB (muninn) HTTP — resolve the real fleet KB, not localhost ─────────────

/** Shape of the arra-oracle MCP server entry we mine for the KB URL. */
interface ClaudeMcpServers {
  ["arra-oracle"]?: { env?: { ORACLE_REMOTE_URL?: string } };
  [key: string]: any;
}

/** Minimal shape of `~/.claude.json` we read — root + per-project mcpServers. */
export interface ClaudeJson {
  mcpServers?: ClaudeMcpServers;
  projects?: Record<string, { mcpServers?: ClaudeMcpServers }>;
}

/** Pull `arra-oracle.env.ORACLE_REMOTE_URL` from an mcpServers map, or "". */
function remoteUrlFrom(servers: ClaudeMcpServers | undefined): string {
  const u = servers?.["arra-oracle"]?.env?.ORACLE_REMOTE_URL;
  return typeof u === "string" ? u.trim() : "";
}

/**
 * Pure KB base-URL resolver — first non-empty wins:
 *   1. env.ORACLE_REMOTE_URL  (someone exported it)
 *   2. env.ARRA_URL           (existing manual override)
 *   3. claude.json → ROOT mcpServers["arra-oracle"].env.ORACLE_REMOTE_URL,
 *      else the first per-project projects.*.mcpServers[...] hit
 *   4. http://localhost:${env.ORACLE_PORT || "47778"}  (fallback)
 *
 * Takes already-parsed inputs (env object + parsed claude.json or null) so it is
 * unit-testable with no real file read. Never throws.
 */
export function resolveKbUrl(args: { env: Record<string, string | undefined>; claudeJson: ClaudeJson | null }): string {
  const { env, claudeJson } = args;

  const exported = env.ORACLE_REMOTE_URL?.trim();
  if (exported) return exported;

  const manual = env.ARRA_URL?.trim();
  if (manual) return manual;

  if (claudeJson) {
    const root = remoteUrlFrom(claudeJson.mcpServers);
    if (root) return root;
    for (const proj of Object.values(claudeJson.projects ?? {})) {
      const perProject = remoteUrlFrom(proj?.mcpServers);
      if (perProject) return perProject;
    }
  }

  return `http://localhost:${env.ORACLE_PORT || "47778"}`;
}

/** Best-effort read+parse of `~/.claude.json`; missing/malformed → null. */
function readClaudeJson(): ClaudeJson | null {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf-8")) as ClaudeJson;
  } catch {
    return null;
  }
}

/** Thin wrapper: read live env + `~/.claude.json` and resolve. Never throws. */
export function kbUrl(): string {
  return resolveKbUrl({ env: process.env, claudeJson: readClaudeJson() });
}

export interface KbLearnPayload {
  pattern: string;
  content: string;
  type: "learning";
  concepts: string[];
  source: string;
}

export interface KbSearchResult {
  content: string;
  type: string;
  source_file: string;
  score: number;
}

/** Minimal fetch surface we depend on — injectable for tests. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/**
 * Build the POST body for `dept learn`. The dept tag goes into `concepts`
 * (for any future concept-aware consumer) AND is embedded inline at the head
 * of `content` — because the search API does NOT return concepts, so the only
 * way `dept knowledge` can client-side filter by dept is to find the tag inside
 * the stored content. `pattern` is a short first-line summary of the knowledge.
 */
export function kbLearnPayload(company: string, dept: string, knowledge: string): KbLearnPayload {
  const deptTag = kbTagFor(company, dept);
  const trimmed = knowledge.trim();
  const firstLine = trimmed.split("\n", 1)[0] ?? "";
  const pattern = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return {
    pattern: pattern || deptTag,
    content: `[${deptTag}] ${trimmed}`,
    type: "learning",
    concepts: [deptTag],
    source: `maw dept learn:${company}/${dept}`,
  };
}

/**
 * ── TWO-SOURCE SEARCH (the dept-entry guarantee) ────────────────────────────
 *
 * `dept knowledge` merges results from TWO independent KB queries so a browse is
 * reliable AND a query still has semantic recall:
 *
 *   1. TAG-EXACT (`kbTagSearchUrl`, mode=fts) — q = the literal `dept:<co>:<dept>`
 *      tag. fts is keyword/exact, so this RELIABLY returns the department's own
 *      entries (the tag is a literal token written inline by `kbLearnPayload`).
 *      Run ALWAYS — this is what guarantees the dept's entries are present,
 *      regardless of how a semantic ranker would have scored them.
 *
 *   2. HYBRID SEMANTIC (`kbHybridSearchUrl`, mode=hybrid) — q = the USER's query
 *      (NOT the tag; the tag would only dilute the semantic ranking). Run ONLY
 *      when a query is given. Brings in semantically-related neighbours.
 *
 * History: a single fts+hard-filter source (#20) lost semantic recall and could
 * hard-drop to 0; a single hybrid+soft-bias source ranked the dept's OWN entries
 * near the bottom so a no-query browse returned 0 dept entries. The two-source
 * merge fixes both: source 1 guarantees the dept entries, source 2 adds recall.
 */

/** Tag-exact (fts) search URL — q is the literal dept tag. Reliably surfaces the dept's own entries. */
export function kbTagSearchUrl(base: string, deptTag: string, limit = 10): string {
  return `${base}/api/search?q=${encodeURIComponent(deptTag)}&limit=${limit}&mode=fts`;
}

/** Hybrid semantic search URL — q is the user's query. Brings in related neighbours. */
export function kbHybridSearchUrl(base: string, query: string, limit = 10): string {
  return `${base}/api/search?q=${encodeURIComponent(query)}&limit=${limit}&mode=hybrid`;
}

/**
 * Whether a result carries the dept tag inline (written there by `kbLearnPayload`).
 * Used to order a merged list tagged-first; NOT a hard filter (the two-source
 * merge already guarantees the dept entries are present).
 */
export function hasDeptTag(r: KbSearchResult, deptTag: string): boolean {
  return typeof r.content === "string" && r.content.includes(deptTag);
}

/** Stable dedup/identity key for a result — prefer source_file, fall back to content. */
function resultKey(r: KbSearchResult): string {
  return (typeof r.source_file === "string" && r.source_file) ? r.source_file : String(r.content ?? "");
}

/**
 * Merge the two sources: dept (tag-exact, source 1) entries FIRST, preserving
 * their order, then hybrid (source 2) neighbours not already present. Deduped by
 * a stable key (`source_file`, else `content`) so an entry surfaced by BOTH
 * sources appears once (kept in its source-1 position). Neither side is dropped.
 */
export function mergeDeptResults(
  tagResults: KbSearchResult[],
  hybridResults: KbSearchResult[],
): KbSearchResult[] {
  const merged: KbSearchResult[] = [];
  const seen = new Set<string>();
  for (const r of tagResults) {
    const k = resultKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  for (const r of hybridResults) {
    const k = resultKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  return merged;
}

// ─── share / sync target planning (pure) ─────────────────────────────────────

/** Resolve a department's lead oracle name, or null when none is set. */
export function resolveLead(company: string, dept: string): string | null {
  return loadCompany(company)?.departments[dept]?.lead ?? null;
}

/** Members to push a `dept share` message to — every member of the dept. */
export function planShareTargets(company: string, dept: string): DeptMember[] {
  return departmentMembers(company, dept);
}

/**
 * Members to soul-sync for `dept sync` — every member EXCEPT the lead (the lead
 * is the source; you don't sync the source to itself).
 */
export function planSyncTargets(company: string, dept: string): DeptMember[] {
  const lead = resolveLead(company, dept);
  return departmentMembers(company, dept).filter((m) => m.oracle !== lead);
}

// ─── async orchestrators (inject I/O — not the pure-logic surface) ───────────

export interface DeptLearnResult {
  ok: boolean;
  /** Human-readable line for the caller to print. */
  message: string;
}

/** POST the knowledge to the KB. Graceful on unreachable / non-2xx — never throws. */
export async function deptLearn(
  company: string,
  dept: string,
  knowledge: string,
  deps: { fetch?: FetchLike; url?: string } = {},
): Promise<DeptLearnResult> {
  const base = deps.url ?? kbUrl();
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const payload = kbLearnPayload(company, dept, knowledge);
  try {
    const res = await doFetch(`${base}/api/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, message: `KB rejected learn (HTTP ${res.status}) at ${base}` };
    }
    return { ok: true, message: `learned → ${kbTagFor(company, dept)} (${payload.pattern})` };
  } catch {
    return { ok: false, message: `KB unreachable at ${base} — knowledge not saved` };
  }
}

export interface DeptKnowledgeResult {
  ok: boolean;
  /** Status / error line (e.g. "KB unreachable"). */
  message: string;
  /** Dept-scoped results (empty on error or no match). */
  results: KbSearchResult[];
}

/** One source's outcome: ok + its results, or a failure (thrown / non-2xx). */
interface SourceOutcome {
  ok: boolean;
  results: KbSearchResult[];
}

/** GET one search URL, best-effort. Never throws — non-2xx / thrown → { ok:false, results:[] }. */
async function fetchSource(doFetch: FetchLike, url: string): Promise<SourceOutcome> {
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, results: [] };
    const data = (await res.json()) as { results?: KbSearchResult[] };
    return { ok: true, results: data.results ?? [] };
  } catch {
    return { ok: false, results: [] };
  }
}

/**
 * GET dept knowledge from the KB via the TWO-SOURCE merge (see `kbTagSearchUrl` /
 * `kbHybridSearchUrl`):
 *
 *   - Source 1 (tag-exact, fts): run ALWAYS. Guarantees the dept's own entries.
 *   - Source 2 (hybrid semantic): run ONLY when a query is given. Adds neighbours.
 *
 * Best-effort PER SOURCE: if one fetch throws / is non-2xx, the other still
 * returns. Only when BOTH fail (or both empty) do we surface the empty/error
 * result. Never throws. Merge keeps dept (source-1) entries first, deduped.
 */
export async function deptKnowledge(
  company: string,
  dept: string,
  query: string | undefined,
  deps: { fetch?: FetchLike; url?: string } = {},
): Promise<DeptKnowledgeResult> {
  const base = deps.url ?? kbUrl();
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const deptTag = kbTagFor(company, dept);
  const trimmedQuery = query?.trim();

  // Source 1 — tag-exact, always. Source 2 — hybrid, only with a query.
  const tag = await fetchSource(doFetch, kbTagSearchUrl(base, deptTag));
  const hybrid = trimmedQuery
    ? await fetchSource(doFetch, kbHybridSearchUrl(base, trimmedQuery))
    : { ok: true, results: [] as KbSearchResult[] };

  // BOTH sources failed (and we actually attempted both / the only one) → error.
  // With a query we attempt both; without one, only source 1 is in play.
  const attemptedHybrid = !!trimmedQuery;
  if (!tag.ok && (!attemptedHybrid || !hybrid.ok)) {
    return { ok: false, message: `KB unreachable at ${base}`, results: [] };
  }

  // Hybrid neighbours = source-2 entries that are NOT the dept's own (those are
  // already guaranteed by source 1); keep dept entries first via mergeDeptResults.
  const hybridNeighbours = hybrid.results.filter((r) => !hasDeptTag(r, deptTag));
  const merged = mergeDeptResults(tag.results, hybridNeighbours);
  const inDept = merged.filter((r) => hasDeptTag(r, deptTag)).length;
  const related = merged.length - inDept;

  const message = `${merged.length} result(s) — ${inDept} in dept '${deptTag}', ${related} related`;
  return { ok: true, message, results: merged };
}

export interface ShareReport {
  oracle: string;
  ok: boolean;
  detail?: string;
}

/** Send fn — defaults to shelling out `maw hey <member> "<msg>"`. Injectable for tests. */
export type SendFn = (member: string, message: string) => Promise<void>;

/**
 * Push `<msg>` to every member of the department (soft grouping — no
 * same-company check). Each send is independent; one failure doesn't abort the
 * rest. Returns a per-member report for the caller to render.
 */
export async function deptShare(
  company: string,
  dept: string,
  message: string,
  deps: { send?: SendFn } = {},
): Promise<ShareReport[]> {
  const send = deps.send ?? defaultSend;
  const targets = planShareTargets(company, dept);
  const reports: ShareReport[] = [];
  for (const m of targets) {
    try {
      await send(m.oracle, message);
      reports.push({ oracle: m.oracle, ok: true });
    } catch (e: any) {
      reports.push({ oracle: m.oracle, ok: false, detail: e?.message ?? String(e) });
    }
  }
  return reports;
}

export interface SyncReport {
  oracle: string;
  ok: boolean;
  detail?: string;
}

export interface DeptSyncResult {
  /** null when the dept has no lead — caller surfaces an error. */
  lead: string | null;
  reports: SyncReport[];
}

/**
 * Sync one member FROM the lead. Defaults to the real soul-sync primitive,
 * invoked with the lead as the SOURCE oracle (via cwd = lead's repo) so it
 * pushes lead.ψ → member. Injectable for tests.
 */
export type SyncFn = (lead: string, member: string) => Promise<void>;

/**
 * `dept sync` — propagate the lead's ψ to every other member.
 *
 * SEMANTICS (verified against soul-sync/impl.ts): `cmdSoulSync(target, opts)` is
 * relative to ONE "current" oracle (derived from opts.cwd, else the tmux pane).
 * It can express exactly two endpoints — current↔peer — so "make member X pull
 * from lead L" is NOT a single arbitrary-pair call. We therefore run the sync
 * with the LEAD as the current oracle (cwd = lead's repo path) and the member
 * as the peer, in PUSH direction → lead.ψ overwrites-newer into member.ψ. That
 * is the faithful realization of "members get the lead's latest ψ".
 *
 * If the dept has no lead, returns `{ lead: null }` so the caller errors out.
 */
export async function deptSync(
  company: string,
  dept: string,
  deps: { sync?: SyncFn } = {},
): Promise<DeptSyncResult> {
  const lead = resolveLead(company, dept);
  if (!lead) return { lead: null, reports: [] };
  const sync = deps.sync ?? defaultSync;
  const targets = planSyncTargets(company, dept);
  const reports: SyncReport[] = [];
  for (const m of targets) {
    try {
      await sync(lead, m.oracle);
      reports.push({ oracle: m.oracle, ok: true });
    } catch (e: any) {
      reports.push({ oracle: m.oracle, ok: false, detail: e?.message ?? String(e) });
    }
  }
  return { lead, reports };
}

// ─── default I/O implementations (not exercised by unit tests) ───────────────

/** Shell out `maw hey <member> "<msg>"` (isolates cmdSend's process.exit). */
async function defaultSend(member: string, message: string): Promise<void> {
  const proc = Bun.spawn(["maw", "hey", member, message], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`maw hey ${member} exited ${code}`);
}

/**
 * Push the lead's ψ to `member` via the real soul-sync primitive. Imports
 * `cmdSoulSync` and pins the source by setting `cwd` to the lead's resolved
 * repo path — this makes soul-sync treat the LEAD as the current oracle and
 * push to `member` (the peer). Importing (vs shelling out) is what lets us pin
 * the source oracle deterministically: a shelled `maw soul-sync` would resolve
 * "current oracle" from the live tmux pane, which we can't control.
 */
async function defaultSync(lead: string, member: string): Promise<void> {
  const { cmdSoulSync, resolveOraclePath } = await import("../soul-sync/impl");
  const leadPath = await resolveOraclePath(lead);
  if (!leadPath) throw new Error(`lead '${lead}' repo not found locally`);
  await cmdSoulSync(member, { cwd: leadPath });
}
