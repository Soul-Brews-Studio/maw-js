import { Tmux } from "../../core/transport/tmux";

export const INBOX_BADGE_BASE_OPTION = "@maw_inbox_status_right_base";
const BADGE_RE = /#\[fg=colour220,bold\]📬 inbox:\d+#\[default\]\s*/g;

export interface InboxStatusBadgeDeps {
  tmux?: Pick<Tmux, "run">;
}

export interface InboxStatusBadgeResult {
  status: "set" | "cleared" | "unchanged" | "failed";
  session: string;
  unread: number;
  reason?: string;
}

function sessionFromTarget(target: string): string {
  return target.split(":", 1)[0]?.trim() || target.trim();
}

export function formatInboxStatusBadge(unread: number): string {
  return `#[fg=colour220,bold]📬 inbox:${unread}#[default]`;
}

export function stripInboxStatusBadge(statusRight: string): string {
  return statusRight.replace(BADGE_RE, "").trimStart();
}

async function showOption(tmux: Pick<Tmux, "run">, session: string, option: string): Promise<string> {
  return (await tmux.run("show-option", "-qv", "-t", session, option)).trim();
}

async function unsetOption(tmux: Pick<Tmux, "run">, session: string, option: string): Promise<void> {
  await tmux.run("set-option", "-q", "-u", "-t", session, option);
}

/**
 * Keep a session-local tmux status-right unread badge visible until the inbox is read.
 *
 * The original status-right is saved once in a @maw_* option, then restored when
 * unread reaches zero. This is intentionally session-scoped and best-effort:
 * message delivery must not fail just because tmux status decoration failed.
 */
export async function updateInboxStatusBadge(
  target: string,
  unread: number,
  deps: InboxStatusBadgeDeps = {},
): Promise<InboxStatusBadgeResult> {
  const session = sessionFromTarget(target);
  const count = Math.max(0, Math.floor(unread));
  const tmux = deps.tmux ?? new Tmux();

  if (!session) return { status: "failed", session, unread: count, reason: "missing tmux session target" };

  try {
    const savedBase = await showOption(tmux, session, INBOX_BADGE_BASE_OPTION).catch(() => "");

    if (count <= 0) {
      if (savedBase) {
        await tmux.run("set-option", "-t", session, "status-right", savedBase);
        await unsetOption(tmux, session, INBOX_BADGE_BASE_OPTION).catch(() => undefined);
        return { status: "cleared", session, unread: count };
      }

      const current = await showOption(tmux, session, "status-right").catch(() => "");
      const stripped = stripInboxStatusBadge(current);
      if (stripped !== current) {
        await tmux.run("set-option", "-t", session, "status-right", stripped);
        return { status: "cleared", session, unread: count };
      }
      return { status: "unchanged", session, unread: count };
    }

    const base = savedBase || stripInboxStatusBadge(await showOption(tmux, session, "status-right").catch(() => ""));
    if (!savedBase) await tmux.run("set-option", "-t", session, INBOX_BADGE_BASE_OPTION, base);

    const next = `${formatInboxStatusBadge(count)} ${base}`.trimEnd();
    await tmux.run("set-option", "-t", session, "status-right", next);
    return { status: "set", session, unread: count };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", session, unread: count, reason };
  }
}
