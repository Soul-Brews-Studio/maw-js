import { tmux } from "maw-js/sdk";
import { cmdWake } from "maw-js/commands/shared/wake";
import { compactIfPaneContextLimited } from "maw-js/commands/shared/context-limit";
import { loadOracleRegistry, type OracleMember } from "./oracle-members";

export interface TeamBringOptions {
  /** Explicit tmux session to bring members into. Defaults to current tmux session or the team name. */
  session?: string;
  /** Engine forwarded to maw wake. */
  engine?: string;
  /** Preview without creating windows or launching engines. */
  dryRun?: boolean;
  /** Open each brought oracle beside the current pane using maw wake --split. */
  split?: boolean;
  /** How long to watch newly woken panes for immediate context-limit freeze. */
  contextLimitPollMs?: number;
}

export function teamOracleMemberNames(members: OracleMember[]): string[] {
  return [...new Set(members.map(m => m.oracle).filter(Boolean))];
}

export function loadTeamOracleMemberNames(teamName: string): string[] {
  const registry = loadOracleRegistry(teamName);
  return registry ? teamOracleMemberNames(registry.members) : [];
}

function validateSessionName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) {
    throw new Error(`invalid session name '${name}' — use letters, numbers, dot, underscore, or dash`);
  }
}

async function currentTmuxSession(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  const out = await tmux.run("display-message", "-p", "#{session_name}").catch(() => "");
  const session = out.trim();
  return session || null;
}

export async function resolveTeamBringSession(teamName: string, opts: TeamBringOptions = {}): Promise<string> {
  const explicit = opts.session?.trim();
  if (explicit) {
    validateSessionName(explicit);
    if (!await tmux.hasSession(explicit)) {
      throw new Error(`target session '${explicit}' not found — run: maw new ${explicit}`);
    }
    return explicit;
  }

  // Prefer the team-named workspace whenever it exists. This keeps the natural
  // flow pasteable from any pane:
  //   maw new <team>; maw team bring <team>
  // Without this, running the command from an oracle's home tmux session brings
  // teammates back into that home session instead of the workspace (#1633).
  if (await tmux.hasSession(teamName)) return teamName;

  const current = await currentTmuxSession();
  if (current) return current;

  throw new Error(`not in tmux and no '${teamName}' session exists — run: maw new ${teamName}`);
}

export async function applyTeamBringLayout(session: string, count: number): Promise<string> {
  const layout = count <= 4 ? "main-vertical" : "tiled";
  // #1616 asks for an automatic layout step. Team members currently wake as
  // tmux windows, so this is best-effort against the human lead window: if the
  // workspace already has panes, tmux arranges them; if it is a single pane,
  // this is harmless and preserves the future pane-join path.
  await tmux.selectLayout(`${session}:lead`, layout).catch(async () => {
    await tmux.selectLayout(`${session}:0`, layout).catch(() => {});
  });
  return layout;
}

export async function cmdTeamBring(teamName: string, opts: TeamBringOptions = {}): Promise<string[]> {
  const members = loadTeamOracleMemberNames(teamName);
  if (members.length === 0) {
    throw new Error(`no oracle members in team '${teamName}' — run: maw team oracle-invite <oracle> --team ${teamName}`);
  }

  const session = await resolveTeamBringSession(teamName, opts);
  console.log(`\x1b[36m⚡\x1b[0m bringing ${members.length} oracle(s) into workspace '${session}'`);

  const targets: string[] = [];
  const woken: Array<{ oracle: string; target: string }> = [];
  for (const oracle of members) {
    if (opts.dryRun) {
      console.log(`  \x1b[90mwould wake ${oracle} --session ${session}${opts.split ? " --split" : ""}\x1b[0m`);
      targets.push(`${session}:${oracle}`);
      continue;
    }
    const target = await cmdWake(oracle, {
      session,
      noRehydrate: true,
      engine: opts.engine,
      split: opts.split,
    });
    targets.push(target);
    woken.push({ oracle, target });
  }

  if (!opts.dryRun) {
    await Promise.all(woken.map(({ oracle, target }) =>
      compactIfPaneContextLimited(target, {
        label: `${session}/${oracle}`,
        pollMs: opts.contextLimitPollMs,
      }).catch((error) => {
        console.warn(`  \x1b[33m⚠\x1b[0m ${session}/${oracle}: context-limit probe failed (${error?.message ?? error})`);
        return false;
      })
    ));
    const layout = await applyTeamBringLayout(session, members.length);
    console.log(`\x1b[32m✓\x1b[0m team '${teamName}' brought into '${session}' (${layout})`);
  }

  return targets;
}
