import { listSessions as defaultListSessions } from "../../core/transport/ssh";
import { Tmux as DefaultTmux } from "../../core/transport/tmux";

type Session = { name: string };
type Reaper = { killSession(name: string): Promise<unknown> };
type ServeLog = { info?: (...args: unknown[]) => void };

type ServeSessionReaperContext = {
  log?: ServeLog;
};

type ServeSessionReaperDeps = {
  listSessions: () => Promise<Session[]>;
  createReaper: () => Reaper;
};

const defaultDeps: ServeSessionReaperDeps = {
  listSessions: defaultListSessions,
  createReaper: () => new DefaultTmux(),
};

export function isStaleServeSession(sessionName: string): boolean {
  return sessionName.startsWith("maw-pty-") || sessionName.endsWith("-view");
}

export async function reapStaleServeSessions(
  deps: Partial<ServeSessionReaperDeps> = {},
  log?: ServeLog,
): Promise<{ ok: true; killed: string[]; checked: number }> {
  const d = { ...defaultDeps, ...deps };

  try {
    const sessions = await d.listSessions();
    const stale = sessions.filter((session) => isStaleServeSession(session.name));
    if (stale.length === 0) return { ok: true, killed: [], checked: sessions.length };

    const reaper = d.createReaper();
    const killed: string[] = [];
    for (const session of stale) {
      await reaper.killSession(session.name);
      killed.push(session.name);
      log?.info?.(`[startup] reaped orphan: ${session.name}`);
    }
    log?.info?.(`[startup] cleaned ${killed.length} orphaned sessions`);
    return { ok: true, killed, checked: sessions.length };
  } catch {
    // tmux may not be running during serve startup; preserve the previous
    // best-effort/no-noise behavior from core/server.ts.
    return { ok: true, killed: [], checked: 0 };
  }
}

export async function serve(
  ctx: ServeSessionReaperContext = {},
  deps?: Partial<ServeSessionReaperDeps>,
): Promise<{ ok: true; killed: string[]; checked: number }> {
  return reapStaleServeSessions(deps, ctx.log);
}

export default serve;
