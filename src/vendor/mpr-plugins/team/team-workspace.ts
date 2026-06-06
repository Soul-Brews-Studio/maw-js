import { tmux } from "maw-js/sdk";
import { cmdWake } from "maw-js/commands/shared/wake";
import { compactIfPaneContextLimited } from "maw-js/commands/shared/context-limit";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadOracleRegistry, type OracleMember } from "./oracle-members";
import { resolvePsi } from "./team-helpers";
import { listPaneSnapshots } from "./team-liveness";

export interface TeamBringOptions {
  /** Explicit tmux session to bring members into. Defaults to current tmux session or the team name. */
  session?: string;
  /** Engine forwarded to maw wake. */
  engine?: string;
  /** Preview without creating windows or launching engines. */
  dryRun?: boolean;
  /** Open each brought oracle beside the current pane using maw wake --split. */
  split?: boolean;
  /** Pull already-live members from existing windows instead of re-waking them. */
  gather?: boolean;
  /** How long to watch newly woken panes for immediate context-limit freeze. */
  contextLimitPollMs?: number;
}

export function teamOracleMemberNames(members: OracleMember[]): string[] {
  return [...new Set(members.map(m => m.oracle).filter(Boolean))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function loadTeamManifestMemberNames(teamName: string): string[] {
  const manifestPath = join(resolvePsi(), "memory", "mailbox", "teams", teamName, "manifest.json");
  if (!existsSync(manifestPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const out: string[] = [];
    const candidates = [
      ...(Array.isArray(raw?.members)
        ? raw.members.map((entry: unknown) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
            return (entry as { name: string }).name;
          }
          return "";
        })
        : []),
      ...(Array.isArray(raw?.charter?.members)
        ? raw.charter.members.map((entry: unknown) => {
          if (entry && typeof entry === "object") {
            if (typeof (entry as { name?: unknown }).name === "string") return (entry as { name: string }).name;
            if (typeof (entry as { role?: unknown }).role === "string") return (entry as { role: string }).role;
          }
          return "";
        })
        : []),
    ];

    return uniqueStrings(candidates);
  } catch {
    return [];
  }
}

function teamWorkspaceWindowCandidates(member: string): string[] {
  const raw = member.trim();
  const stripped = raw.replace(/-oracle$/i, "");
  return [...new Set([raw, stripped, stripped ? `${stripped}-oracle` : ""].filter(Boolean))];
}

export function loadTeamOracleMemberNames(teamName: string): string[] {
  const registry = loadOracleRegistry(teamName);
  const fromRegistry = registry ? teamOracleMemberNames(registry.members) : [];
  const fromManifest = loadTeamManifestMemberNames(teamName);
  return [...new Set([...fromRegistry, ...fromManifest])];
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
  const liveTargets = opts.gather ? await findLiveTeamTargets(members, session).catch(() => new Map()) : new Map<string, string | null>();
  for (const oracle of members) {
    const liveTarget = liveTargets.get(oracle) ?? null;
    const alreadyInSession = liveTarget && liveTarget.startsWith(`${session}:`);

    if (opts.dryRun) {
      if (opts.gather && liveTarget && !alreadyInSession) {
        console.log(`\x1b[90mwould gather ${oracle} from ${liveTarget}\x1b[0m`);
      } else if (opts.gather && liveTarget && alreadyInSession) {
        console.log(`\x1b[90m${oracle} already live in ${liveTarget}\x1b[0m`);
      } else {
        console.log(`\x1b[90mwould wake ${oracle} --session ${session}${opts.split && !opts.gather ? " --split" : ""}\x1b[0m`);
      }
      targets.push(liveTarget && !alreadyInSession ? `${session}:${oracle}` : liveTarget ?? `${session}:${oracle}`);
      continue;
    }

    if (opts.gather && liveTarget && alreadyInSession) {
      targets.push(liveTarget);
      continue;
    }

    if (opts.gather && liveTarget && !alreadyInSession) {
      await tmux.run("join-pane", "-s", liveTarget);
      targets.push(`${session}:${oracle}`);
      continue;
    }

    const target = await cmdWake(oracle, {
      session,
      noRehydrate: true,
      engine: opts.engine,
      split: opts.gather ? false : opts.split,
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
        console.warn(`\x1b[33m⚠\x1b[0m ${session}/${oracle}: context-limit probe failed (${error?.message ?? error})`);
        return false;
      })
    ));
    const layout = await applyTeamBringLayout(session, members.length);
    console.log(`\x1b[32m✓\x1b[0m team '${teamName}' brought into '${session}' (${layout})`);
  }

  return targets;
}

async function findLiveTeamTargets(members: string[], session: string): Promise<Map<string, string | null>> {
  const targetSet = new Set(members);
  if (targetSet.size === 0) return new Map();

  const panes = await listPaneSnapshots();
  const output = new Map<string, string | null>();

  for (const oracle of members) {
    if (!targetSet.has(oracle)) continue;

    const wanted = new Set(teamWorkspaceWindowCandidates(oracle).map((value) => value.toLowerCase()));

    const inSession = panes.find((pane) =>
      pane.sessionName === session && wanted.has(pane.windowName.toLowerCase())
    );
    if (inSession) {
      output.set(oracle, `${session}:${inSession.windowName}`);
      continue;
    }

    const inOther = panes.find((pane) =>
      pane.sessionName !== session && wanted.has(pane.windowName.toLowerCase())
    );
    output.set(oracle, inOther ? `${inOther.sessionName}:${inOther.windowName}` : null);
  }

  return output;
}
