import {
  loadCompany, departmentMembers, kbTagFor,
  type DeptMember,
} from "./company-helpers";

/**
 * Company plugin — Department Knowledge Exchange (spec §4, Phase 2.2).
 *
 *   maw dept learn     <co> <dept> "<knowledge>"   write → KB (muninn), dept-tagged
 *   maw dept knowledge <co> <dept> [<query>]       search KB, scoped to the dept tag
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

// ─── KB (muninn) HTTP — mirror the `dream` plugin's base-URL resolution ──────

export function kbUrl(): string {
  return process.env.ARRA_URL || `http://localhost:${process.env.ORACLE_PORT || "47778"}`;
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
 * Build the KB search URL. The dept tag is prepended to the query so the tag
 * boosts relevance; results are then post-filtered by `filterByDeptTag`. When
 * the user gives no query, the tag alone is the query.
 */
export function kbSearchUrl(base: string, deptTag: string, query?: string): string {
  const q = query && query.trim() ? `${deptTag} ${query.trim()}` : deptTag;
  return `${base}/api/search?q=${encodeURIComponent(q)}&limit=10&mode=hybrid`;
}

/**
 * Best-effort dept scoping: the search endpoint has no concept filter and does
 * not return concepts, so we keep only results whose `content` embeds the dept
 * tag (written there by `kbLearnPayload`). Trade-off: knowledge stored OUTSIDE
 * `dept learn` (which lacks the inline tag) won't match — accepted per spec.
 */
export function filterByDeptTag(results: KbSearchResult[], deptTag: string): KbSearchResult[] {
  return results.filter((r) => typeof r.content === "string" && r.content.includes(deptTag));
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

/** GET dept-scoped search results from the KB. Graceful on unreachable / non-2xx. */
export async function deptKnowledge(
  company: string,
  dept: string,
  query: string | undefined,
  deps: { fetch?: FetchLike; url?: string } = {},
): Promise<DeptKnowledgeResult> {
  const base = deps.url ?? kbUrl();
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const deptTag = kbTagFor(company, dept);
  try {
    const res = await doFetch(kbSearchUrl(base, deptTag, query), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, message: `KB rejected search (HTTP ${res.status}) at ${base}`, results: [] };
    }
    const data = (await res.json()) as { results?: KbSearchResult[] };
    const scoped = filterByDeptTag(data.results ?? [], deptTag);
    return { ok: true, message: `${scoped.length} result(s) for ${deptTag}`, results: scoped };
  } catch {
    return { ok: false, message: `KB unreachable at ${base}`, results: [] };
  }
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
