import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { Session } from "../../core/transport/ssh";
import type { ReceiverInboxResult } from "./receiver-inbox";
import { updateInboxStatusBadge } from "./inbox-status-badge";

export type LiveInboxNotifyStatus = "sent" | "not-live" | "failed";

export interface LiveInboxNotifyResult {
  status: LiveInboxNotifyStatus;
  target?: string;
  message?: string;
  reason?: string;
}

export interface LiveInboxNotifyDeps {
  listSessions: () => Promise<Session[]>;
  tmux: { run: (...args: string[]) => Promise<string> };
  countUnread?: (inboxDir: string) => number | Promise<number>;
}

function normalizeInboxTargetName(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/\.[0-9]+$/, "")
    .replace(/^\d+-/, "")
    .replace(/-oracle$/i, "")
    .toLowerCase();
}

function windowTarget(session: Session, window: Session["windows"][number] | undefined): string {
  if (!window) return session.name;
  return `${session.name}:${window.name || window.index}`;
}

function receiverNamedWindow(session: Session, wanted: string): Session["windows"][number] | undefined {
  return session.windows.find((window) => normalizeInboxTargetName(window.name) === wanted);
}

/** @internal exported for tests. Resolve an inbox oracle to a live tmux target. */
export function resolveLiveInboxNotificationTarget(oracle: string, sessions: Session[]): string | null {
  const wanted = normalizeInboxTargetName(oracle);
  if (!wanted) return null;

  for (const session of sessions) {
    const namedWindow = receiverNamedWindow(session, wanted);
    if (namedWindow) return windowTarget(session, namedWindow);

    if (normalizeInboxTargetName(session.name) === wanted) {
      return windowTarget(session, session.windows.find(w => w.active) ?? session.windows[0]);
    }
  }

  return null;
}

function isUnreadInboxFile(content: string): boolean {
  return /^read:\s*false\s*$/im.test(content);
}

/** @internal exported for tests. */
export function countUnreadInboxFiles(inboxDir: string): number {
  if (!existsSync(inboxDir)) throw new Error(`inbox dir not found: ${inboxDir}`);
  let count = 0;
  for (const name of readdirSync(inboxDir)) {
    if (!name.endsWith(".md")) continue;
    try {
      if (isUnreadInboxFile(readFileSync(join(inboxDir, name), "utf8"))) count += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`read inbox file failed: ${name}: ${reason}`);
    }
  }
  return count;
}

/** @internal exported for tests. */
export function formatInboxNotification(
  inbox: Extract<ReceiverInboxResult, { ok: true }>,
  from: string,
  unreadCount: number,
): string {
  return `📬 inbox +${unreadCount} from ${from} — ว่างแล้วค่อย maw inbox (ψ/inbox/${inbox.filename})`;
}

export async function notifyLiveInboxReceiver(
  inbox: ReceiverInboxResult,
  from: string,
  deps: LiveInboxNotifyDeps,
): Promise<LiveInboxNotifyResult> {
  if (!inbox.ok) return { status: "failed", reason: inbox.reason || "receiver inbox write failed" };

  let sessions: Session[];
  try {
    sessions = await deps.listSessions();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", reason: `list tmux sessions failed: ${reason}` };
  }

  const target = resolveLiveInboxNotificationTarget(inbox.oracle, sessions);
  if (!target) return { status: "not-live", reason: `no live tmux pane resolved for inbox receiver '${inbox.oracle}'` };

  let unreadCount: number;
  try {
    unreadCount = await (deps.countUnread ?? countUnreadInboxFiles)(inbox.inboxDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", target, reason: `count unread inbox failed for ${inbox.inboxDir}: ${reason}` };
  }

  // Badge is stronger Layer-2 awareness, but advisory: do not drop the
  // durable inbox write or transient status ping if tmux status-right cannot
  // be decorated in this environment.
  await updateInboxStatusBadge(target, unreadCount, { tmux: deps.tmux });

  const message = formatInboxNotification(inbox, from, unreadCount);
  try {
    // Awareness only: tmux status message, not send-keys into the agent input.
    await deps.tmux.run("display-message", "-d", "5000", "-t", target, message);
    return { status: "sent", target, message };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", target, reason: `tmux display-message failed for ${target}: ${reason}` };
  }
}
