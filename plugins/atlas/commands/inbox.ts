/**
 * maw atlas inbox — read unread inbox messages from ψ/inbox/
 *
 * Usage:
 *   maw atlas inbox              # show unread (today)
 *   maw atlas inbox --all        # show all unread
 *   maw atlas inbox --from=mawjs # filter by sender
 *   maw atlas inbox --mark-read  # mark all as read
 */
import { findAtlasRepo } from "../lib/repo";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export async function inbox(log: (s: string) => void, args: string[]) {
  const repo = findAtlasRepo();
  if (!repo) { log("✗ atlas-oracle repo not found"); return; }

  const inboxDir = join(repo, "ψ/inbox");
  if (!existsSync(inboxDir)) { log("✗ no ψ/inbox/ directory"); return; }

  const showAll = args.includes("--all");
  const markRead = args.includes("--mark-read");
  const fromFilter = args.find(a => a.startsWith("--from="))?.split("=")[1]?.toLowerCase();
  const today = new Date().toISOString().slice(0, 10);

  const files = readdirSync(inboxDir)
    .filter(f => f.endsWith(".md"))
    .sort();

  const unread: { file: string; from: string; date: string; preview: string; content: string }[] = [];

  for (const f of files) {
    if (!showAll && !f.startsWith(today)) continue;

    const path = join(inboxDir, f);
    const content = readFileSync(path, "utf8");

    // check if already read
    if (content.includes("read: true")) continue;

    // extract from
    const fromMatch = content.match(/from:\s*"?\[?([^\]"\n]+)/i);
    const from = fromMatch?.[1]?.trim() || "unknown";

    if (fromFilter && !from.toLowerCase().includes(fromFilter)) continue;

    const date = f.slice(0, 10);
    const lines = content.split("\n").filter(l => !l.startsWith("---") && !l.startsWith("from:") && !l.startsWith("to:") && !l.startsWith("date:") && !l.startsWith("read:") && l.trim());
    const preview = lines[0]?.slice(0, 100) || "(empty)";

    unread.push({ file: f, from, date, preview, content });
  }

  if (unread.length === 0) {
    log(showAll ? "📭 inbox empty (no unread)" : `📭 no unread messages today (${today}). try --all`);
    return;
  }

  log(`📬 ${unread.length} unread message(s)${showAll ? "" : ` (${today})`}:`);
  log("");

  for (const msg of unread) {
    log(`  📩 ${msg.from}`);
    log(`     ${msg.date} — ${msg.file}`);
    log(`     ${msg.preview}`);
    log("");
  }

  if (markRead) {
    let marked = 0;
    for (const msg of unread) {
      const path = join(inboxDir, msg.file);
      const content = readFileSync(path, "utf8");
      let updatedContent = content;
      let isModified = false;

      if (/^read:\s*false\s*$/im.test(content)) {
        updatedContent = content.replace(/^read:\s*false\s*$/im, "read: true");
        isModified = true;
      } else if (!/^read:/im.test(content)) {
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        if (match) {
          const lineEnd = content.includes("\r\n") ? "\r\n" : "\n";
          const oldFm = match[1];
          const newFm = oldFm + `${lineEnd}read: true`;
          updatedContent = content.replace(oldFm, newFm);
          isModified = true;
        }
      } else {
        updatedContent = content.replace(/^read:\s*.*$/im, "read: true");
        isModified = true;
      }

      if (isModified) {
        // Inject readAt if not present
        if (!/^readAt:/im.test(updatedContent)) {
          const match = updatedContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
          if (match) {
            const lineEnd = updatedContent.includes("\r\n") ? "\r\n" : "\n";
            const oldFm = match[1];
            const newFm = oldFm + `${lineEnd}readAt: ${new Date().toISOString()}`;
            updatedContent = updatedContent.replace(oldFm, newFm);
          }
        }
        writeFileSync(path, updatedContent);
        marked++;
      }
    }
    log(`✓ marked ${marked} message(s) as read`);
  }
}
