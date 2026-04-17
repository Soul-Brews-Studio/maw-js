import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../../config";

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
