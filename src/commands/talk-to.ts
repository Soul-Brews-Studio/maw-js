import { loadConfig } from "../config";
import { listSessions, sendKeys, getPaneCommand } from "../ssh";
import { findWindow } from "../find-window";
import { runHook } from "../hooks";
import { appendFile, mkdir } from "fs/promises";
import { homedir, hostname } from "os";
import { join } from "path";

const ORACLE_URL = () => process.env.ORACLE_URL || loadConfig().oracleUrl;

interface ThreadResponse {
  thread_id: number;
  message_id: number;
  status: string;
  oracle_response?: {
    content: string;
    principles_found: number;
    patterns_found: number;
  } | null;
}

interface ThreadInfo {
  thread: {
    id: number;
    title: string;
    status: string;
    created_at: string;
  };
  messages: {
    id: number;
    role: string;
    content: string;
    created_at: string;
  }[];
}

/**
 * Find or create a channel thread for a target.
 * Convention: thread title = "channel:<target>"
 */
async function findChannelThread(target: string): Promise<number | null> {
  try {
    const res = await fetch(`${ORACLE_URL()}/api/threads?limit=50`);
    if (!res.ok) return null;
    const data = await res.json() as { threads: { id: number; title: string; status: string }[] };
    const channel = data.threads.find(t => t.title === `channel:${target}` && t.status !== "closed");
    return channel?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Post message to oracle_thread (MCP persistence layer).
 */
async function postToThread(target: string, message: string): Promise<ThreadResponse | null> {
  const threadId = await findChannelThread(target);
  const body: Record<string, unknown> = {
    message,
    role: "claude",
  };
  if (threadId) {
    body.thread_id = threadId;
  } else {
    body.title = `channel:${target}`;
  }

  try {
    const res = await fetch(`${ORACLE_URL()}/api/thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`\x1b[31merror\x1b[0m: Oracle API returned ${res.status}`);
      return null;
    }
    return await res.json() as ThreadResponse;
  } catch (e: any) {
    console.error(`\x1b[31merror\x1b[0m: Oracle unreachable — ${e.message}`);
    return null;
  }
}

/**
 * Get thread message count.
 */
async function getThreadInfo(threadId: number): Promise<{ messageCount: number } | null> {
  try {
    const res = await fetch(`${ORACLE_URL()}/api/thread/${threadId}`);
    if (!res.ok) return null;
    const data = await res.json() as ThreadInfo;
    return { messageCount: data.messages.length };
  } catch {
    return null;
  }
}

/**
 * maw talk-to <target> "message"
 *
 * 1. Post to oracle_thread (MCP) → persistent
 * 2. Send maw hey to target → notification with context
 *
 * MCP first, hey after. Order matters.
 */
export async function cmdTalkTo(target: string, message: string, force = false) {
  // Step 1: Post to oracle_thread
  console.log(`\x1b[36m💬\x1b[0m posting to thread channel:${target}...`);
  const threadResult = await postToThread(target, message);

  if (!threadResult) {
    console.error(`\x1b[33mwarn\x1b[0m: thread post failed — falling back to maw hey only`);
  }

  // Step 2: Build notification with context
  const from = process.env.CLAUDE_AGENT_NAME || "cli";
  const preview = message.length > 80 ? message.slice(0, 77) + "..." : message;

  let notification: string;
  if (threadResult) {
    const info = await getThreadInfo(threadResult.thread_id);
    const msgCount = info?.messageCount ?? "?";
    notification = [
      `💬 channel:${target} (#${threadResult.thread_id}) — ${msgCount} msgs`,
      `From: ${from}`,
      `Preview: "${preview}"`,
      `→ อ่านเต็มที่ thread #${threadResult.thread_id} หรือพิมพ์ /talk-to #${threadResult.thread_id}`,
    ].join("\n");
  } else {
    notification = [
      `💬 from ${from}`,
      `"${preview}"`,
    ].join("\n");
  }

  // Step 3: Send hey with context
  const sessions = await listSessions();
  const tmuxTarget = findWindow(sessions, target);
  if (!tmuxTarget) {
    // Thread was posted but target window not found — still useful
    if (threadResult) {
      console.log(`\x1b[32m✓\x1b[0m thread #${threadResult.thread_id} updated`);
      console.log(`\x1b[33mwarn\x1b[0m: window "${target}" not found — message saved to thread only`);
    } else {
      console.error(`\x1b[31merror\x1b[0m: window "${target}" not found`);
      process.exit(1);
    }
    return;
  }

  // Check if agent is running
  if (!force) {
    const cmd = await getPaneCommand(tmuxTarget);
    const isAgent = /claude|codex|node/i.test(cmd);
    if (!isAgent) {
      if (threadResult) {
        console.log(`\x1b[32m✓\x1b[0m thread #${threadResult.thread_id} updated`);
        console.log(`\x1b[33mwarn\x1b[0m: no active Claude in ${tmuxTarget} — message saved to thread only`);
      } else {
        console.error(`\x1b[31merror\x1b[0m: no active Claude session in ${tmuxTarget} (use --force)`);
        process.exit(1);
      }
      return;
    }
  }

  await sendKeys(tmuxTarget, notification);
  await runHook("after_send", { to: target, message: notification });

  // Log to maw-log.jsonl
  const logDir = join(homedir(), ".oracle");
  const logFile = join(logDir, "maw-log.jsonl");
  const host = hostname();
  const sid = process.env.CLAUDE_SESSION_ID || null;
  const ch = threadResult ? `thread:${threadResult.thread_id}` : undefined;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    from,
    to: target,
    target: tmuxTarget,
    msg: message,
    host,
    sid,
    ch,
  }) + "\n";
  try { await mkdir(logDir, { recursive: true }); await appendFile(logFile, line); } catch (e) { console.error(`\x1b[33m⚠\x1b[0m talk-to log write failed: ${e}`); }

  console.log(`\x1b[32m✓\x1b[0m thread #${threadResult?.thread_id ?? "?"} + sent → ${tmuxTarget}`);
}
