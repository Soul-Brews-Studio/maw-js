import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../../config";
import {
  deletePending,
  loadPending,
  loadPendingById,
  updatePending,
  type PendingMessage,
} from "../../shared/queue-store";

// Re-export queue-store helpers so callers can import from one place.
export {
  loadPending,
  loadPendingById,
  savePending,
  updatePending,
  deletePending,
  pendingDir,
  pendingPath,
  isExpired,
  TTL_MS,
} from "../../shared/queue-store";
export type { PendingMessage } from "../../shared/queue-store";

// File naming: YYYY-MM-DD_HH-MM_<from>_<slug>.md
// Frontmatter: from / to / timestamp / read

interface InboxFrontmatter {
  from: string;
  to: string;
  timestamp: string;
  read: boolean;
}

export interface InboxMessage {
  id: string;
  filename: string;
  path: string;
  frontmatter: InboxFrontmatter;
  body: string;
  timestamp: Date;
}

export function resolveInboxDir(): string {
  const config = loadConfig();
  if (config.psiPath) return join(config.psiPath, "inbox");
  const local = join(process.cwd(), "ψ", "inbox");
  if (existsSync(local)) return local;
  return join(process.cwd(), "psi", "inbox");
}

function parseFrontmatter(content: string): { frontmatter: InboxFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm: InboxFrontmatter = { from: "unknown", to: "unknown", timestamp: "", read: false };
  if (!match) return { frontmatter: fm, body: content };
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(": ");
    if (colon < 0) continue;
    const k = line.slice(0, colon);
    const v = line.slice(colon + 2).trim();
    if (k === "from") fm.from = v;
    else if (k === "to") fm.to = v;
    else if (k === "timestamp") fm.timestamp = v;
    else if (k === "read") fm.read = v === "true";
  }
  return { frontmatter: fm, body: match[2].trim() };
}

function buildFrontmatter(fm: InboxFrontmatter): string {
  return `---\nfrom: ${fm.from}\nto: ${fm.to}\ntimestamp: ${fm.timestamp}\nread: ${fm.read}\n---\n`;
}

function slugify(text: string): string {
  return text.trim().split(/\s+/).slice(0, 5).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
}

function relativeTime(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function writeInboxFile(inboxDir: string, from: string, to: string, body: string): string {
  if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
  const now = new Date();
  const ts = now.toISOString().slice(0, 10) + "_" + now.toTimeString().slice(0, 5).replace(":", "-");
  const filename = `${ts}_${from}_${slugify(body)}.md`;
  const fm: InboxFrontmatter = { from, to, timestamp: now.toISOString(), read: false };
  writeFileSync(join(inboxDir, filename), buildFrontmatter(fm) + "\n" + body + "\n");
  return filename;
}

export function loadInboxMessages(inboxDir: string): InboxMessage[] {
  if (!existsSync(inboxDir)) return [];
  const messages: InboxMessage[] = [];
  for (const f of readdirSync(inboxDir)) {
    if (!f.endsWith(".md")) continue;
    const path = join(inboxDir, f);
    try {
      const content = readFileSync(path, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      messages.push({
        id: f.replace(/\.md$/, ""),
        filename: f,
        path,
        frontmatter,
        body,
        timestamp: frontmatter.timestamp ? new Date(frontmatter.timestamp) : new Date(0),
      });
    } catch { /* skip unreadable files */ }
  }
  return messages.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

export async function cmdInboxLs(opts: { unread?: boolean; from?: string; last?: number } = {}) {
  let msgs = loadInboxMessages(resolveInboxDir());
  if (opts.unread) msgs = msgs.filter(m => !m.frontmatter.read);
  if (opts.from) msgs = msgs.filter(m => m.frontmatter.from === opts.from);
  if (!msgs.length) { console.log("\x1b[90mno inbox messages\x1b[0m"); return; }
  const shown = msgs.slice(0, opts.last ?? 20);

  const FROM_W = 14;
  const WHEN_W = 10;
  console.log(`\n\x1b[36mINBOX\x1b[0m (${msgs.length} total)\n`);
  console.log(`  ${"R"} ${"FROM".padEnd(FROM_W)} ${"WHEN".padEnd(WHEN_W)} SUBJECT`);
  console.log(`  ${"-"} ${"-".repeat(FROM_W)} ${"-".repeat(WHEN_W)} ${"-".repeat(44)}`);
  for (const msg of shown) {
    const dot = msg.frontmatter.read ? "\x1b[90m○\x1b[0m" : "\x1b[32m●\x1b[0m";
    const from = msg.frontmatter.from.slice(0, FROM_W).padEnd(FROM_W);
    const when = relativeTime(msg.timestamp).padEnd(WHEN_W);
    const subject = msg.body.replace(/\n/g, " ").slice(0, 50);
    console.log(`  ${dot} ${from} ${when} ${subject}`);
  }
  console.log();
}

export async function cmdInboxMarkRead(id: string) {
  if (!id) { console.error("usage: maw inbox read <id>"); return; }
  const msgs = loadInboxMessages(resolveInboxDir());
  const msg = msgs.find(m => m.id === id || m.filename.includes(id));
  if (!msg) { console.error(`\x1b[31merror\x1b[0m: message not found: ${id}`); return; }
  if (msg.frontmatter.read) { console.log(`\x1b[90malready read:\x1b[0m ${msg.filename}`); return; }
  const content = readFileSync(msg.path, "utf-8");
  writeFileSync(msg.path, content.replace(/^read: false$/m, "read: true"));
  console.log(`\x1b[32m✓\x1b[0m marked read: ${msg.filename}`);
}

// Legacy write shim — used by the oracle inbox skill
export async function cmdInboxRead(target?: string) {
  const msgs = loadInboxMessages(resolveInboxDir());
  if (!msgs.length) { console.log("\x1b[90mno inbox messages\x1b[0m"); return; }
  const n = target ? parseInt(target) : NaN;
  const msg = !target ? msgs[0]
    : !isNaN(n) ? msgs[n - 1]
    : msgs.find(m => m.id.toLowerCase().includes(target.toLowerCase()));
  if (!msg) { console.error(`\x1b[31merror\x1b[0m: not found: ${target}`); return; }
  console.log(`\n\x1b[36m${msg.filename}\x1b[0m\n\x1b[90mfrom: ${msg.frontmatter.from}  ${msg.timestamp.toISOString()}\x1b[0m\n`);
  console.log(msg.body);
}

// Legacy write shim
export async function cmdInboxWrite(note: string) {
  const inboxDir = resolveInboxDir();
  if (!existsSync(inboxDir)) { console.error(`\x1b[31merror\x1b[0m: inbox not found: ${inboxDir}`); return; }
  const config = loadConfig();
  const filename = writeInboxFile(inboxDir, config.node ?? "cli", config.node ?? "local", note);
  console.log(`\x1b[32m✓\x1b[0m wrote \x1b[33m${filename}\x1b[0m`);
}

// ─── Approval queue (#842 Sub-C) ────────────────────────────────────────────
//
// `cmdList` / `cmdApprove` / `cmdReject` / `cmdShow` operate on the
// per-message JSON files under `<CONFIG_DIR>/pending/` written by
// `comm-send.ts` when `evaluateAclFromDisk(...) === "queue"`. The plugin
// dispatcher in `index.ts` peels the verb off and routes here.
//
// Approve flow: flip status → re-issue the send via `cmdSend(query, message)`
// (the same code path operators take with `maw hey`). On a successful send
// we delete the file (the approval was the gate; the file no longer needs
// to exist). Reject flow: flip status briefly so observers can see the
// terminal state, then delete the file unconditionally.

/**
 * Resolve a partial id (e.g. user types the timestamp prefix) to a full
 * pending file. Returns the loaded {@link PendingMessage} or `null`. If
 * multiple pending files match the prefix, the oldest is returned —
 * mirrors the "oldest first" semantics of `cmdQueueList()`.
 */
export function resolvePendingId(idOrPrefix: string): PendingMessage | null {
  if (!idOrPrefix) return null;
  // Exact match first — common case after `maw inbox pending` prints the id.
  const exact = loadPendingById(idOrPrefix);
  if (exact) return exact;
  // Fallback: prefix match. List loads + reaps in one pass; the user is
  // never given a stale id by the list output, so prefix is safe.
  const list = loadPending();
  const matches = list.filter(m => m.id.startsWith(idOrPrefix));
  if (matches.length === 0) return null;
  return matches[0]; // oldest first
}

/** List pending messages, oldest first. Pure read — no mutation. */
export function cmdQueueList(): PendingMessage[] {
  return loadPending().filter(m => m.status === "pending");
}

/**
 * Format the pending list for human consumption. Mirrors `formatList` in
 * `scope/impl.ts` and `trust/impl.ts` — padded columns, header + divider.
 */
export function formatQueueList(rows: PendingMessage[]): string {
  if (!rows.length) return "no pending messages";
  const header = ["id", "sender", "target", "sentAt", "preview"];
  const lines = rows.map(r => [
    r.id,
    r.sender,
    r.target,
    r.sentAt,
    r.message.replace(/\s+/g, " ").slice(0, 50),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map(l => l[i].length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [
    fmt(header),
    fmt(widths.map(w => "-".repeat(w))),
    ...lines.map(fmt),
  ].join("\n");
}

/** Show a single pending message in human-readable detail. */
export function formatQueueDetail(msg: PendingMessage): string {
  return [
    `id:      ${msg.id}`,
    `sender:  ${msg.sender}`,
    `target:  ${msg.target}`,
    `query:   ${msg.query ?? "-"}`,
    `sentAt:  ${msg.sentAt}`,
    `status:  ${msg.status}`,
    `message:`,
    msg.message,
  ].join("\n");
}

/**
 * Approve a queued message → mark status "approved" + execute the send via
 * `cmdSend(query, message)` (lazy import to avoid a circular module load:
 * comm-send imports this plugin's loader chain). On successful send we
 * delete the file. Returns the record that was just approved (status
 * pre-delete) for caller logging.
 *
 * Throws if the id is unknown or the underlying send rejects (the file is
 * left intact in that case so the operator can retry).
 */
export async function cmdApprove(idOrPrefix: string): Promise<PendingMessage> {
  const found = resolvePendingId(idOrPrefix);
  if (!found) throw new Error(`pending message not found: ${idOrPrefix}`);
  if (found.status !== "pending") {
    throw new Error(`message ${found.id} is already ${found.status}`);
  }
  const updated = updatePending(found.id, { status: "approved" });
  // Re-issue the send. Use the original query string when present (preserves
  // node prefix routing); fall back to target name otherwise.
  const query = updated.query ?? updated.target;
  const { cmdSend } = await import("../../shared/comm-send");
  // Pass `force=true` plus a sentinel to bypass ACL on the second pass:
  // the human approval IS the gate — re-checking here would loop forever.
  process.env.MAW_ACL_BYPASS = "1";
  try {
    await cmdSend(query, updated.message);
  } finally {
    delete process.env.MAW_ACL_BYPASS;
  }
  // Successful send → file's job is done. Delete it.
  deletePending(updated.id);
  return updated;
}

/**
 * Reject a queued message → mark status "rejected" + delete the file.
 * Returns the record (with status flipped) so the caller can log the
 * rejection. Throws on unknown id.
 */
export function cmdReject(idOrPrefix: string): PendingMessage {
  const found = resolvePendingId(idOrPrefix);
  if (!found) throw new Error(`pending message not found: ${idOrPrefix}`);
  if (found.status === "rejected") {
    // Idempotent — already rejected. Still delete in case the file was left
    // behind by a partial earlier reject.
    deletePending(found.id);
    return found;
  }
  const updated = updatePending(found.id, { status: "rejected" });
  deletePending(updated.id);
  return updated;
}

/**
 * Show a single pending message by id. Returns `null` if not found —
 * the dispatcher converts that to a CLI error. Pure read.
 */
export function cmdShow(idOrPrefix: string): PendingMessage | null {
  return resolvePendingId(idOrPrefix);
}
