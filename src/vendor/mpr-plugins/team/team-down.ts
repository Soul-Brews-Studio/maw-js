// Charter-driven team teardown (#2002). Runtime loads this vendored plugin copy.
import { readTeamCharter, type TeamCharterMember } from "./team-charter";
import { loadConfig } from "../../../config/load";
import type { MawConfig } from "../../../config/types";
import { Tmux } from "../../../core/transport/tmux";
import {
  classifyMember,
  currentTmuxSession,
  listPaneSnapshots,
  memberMatchesSelector,
  resolveCharterPath,
  type ClassifiedTeamMember,
} from "./team-liveness";

export const TEAM_LIFECYCLE_GUARD_WINDOW = "maw-team-lifecycle-guard";

export interface TeamDownOptions {
  all?: boolean;
  keep?: string[];
  status?: boolean;
  dryRun?: boolean;
}

export interface TeamDownAction {
  role: string;
  state: string;
  action: string;
  target?: string;
}

export interface TeamDownResult {
  team: string;
  session: string;
  roster: ClassifiedTeamMember[];
  actions: TeamDownAction[];
  output: string;
}

export interface TeamDownDeps {
  tmux?: Pick<Tmux, "run">;
  cwd?: string;
  charterPath?: string | null;
  readTeamCharterFn?: typeof readTeamCharter;
  loadConfigFn?: typeof loadConfig;
  cmdDoneFn?: (windowName: string, opts?: { sessionName?: string; dryRun?: boolean; force?: boolean }) => Promise<void>;
  logger?: (line: string) => void;
}

function isLead(member: TeamCharterMember): boolean {
  return member.role === "lead" || member.role === "bridge";
}

function renderRoster(team: string, session: string, roster: ClassifiedTeamMember[], actions: TeamDownAction[], tail?: string): string {
  const actionByRole = new Map(actions.map((action) => [action.role, action]));
  const lines = [`team down: ${team} (${session})`, "role\tengine\tstate\taction"];
  for (const item of roster) {
    const action = actionByRole.get(item.role)?.action ?? "skip";
    lines.push(`${item.role}\t${item.engine ?? "(default)"}\t${item.state}\t${action}`);
  }
  if (tail) lines.push("", tail);
  return lines.join("\n");
}

function keepReason(item: ClassifiedTeamMember, keep: string[], includeLead: boolean): string | null {
  if (item.state === "skipped") return item.skipReason ?? "guard";
  if (!includeLead && isLead(item.member)) return "lead";
  if (keep.some((selector) => memberMatchesSelector(item.member, selector))) return "--keep";
  return null;
}

export async function cmdTeamDown(team: string, opts: TeamDownOptions = {}, deps: TeamDownDeps = {}): Promise<TeamDownResult> {
  const cwd = deps.cwd ?? process.cwd();
  const charterPath = deps.charterPath !== undefined ? deps.charterPath : resolveCharterPath(team, cwd);
  if (!charterPath) throw new Error(`charter not found: ${team}`);

  const read = deps.readTeamCharterFn ?? readTeamCharter;
  const charter = read(charterPath);
  const tmux = deps.tmux ?? new Tmux();
  const config: MawConfig = (deps.loadConfigFn ?? loadConfig)();
  const currentSession = await currentTmuxSession(tmux).catch(() => "");
  const session = charter.session ?? currentSession;
  const panes = await listPaneSnapshots(tmux);
  const roster = charter.members.map((member) => classifyMember(member, panes, session, { currentNode: config.node }));
  const keep = opts.keep ?? [];
  const actions: TeamDownAction[] = [];
  let done = deps.cmdDoneFn;

  const killableLive = roster.filter((item) => {
    const reason = keepReason(item, keep, Boolean(opts.all));
    return !reason && item.state === "live";
  });
  const sessionWindows = new Set(
    panes
      .filter((pane) => pane.sessionName === session)
      .map((pane) => pane.windowName)
      .filter((name) => name !== TEAM_LIFECYCLE_GUARD_WINDOW),
  );
  const killWindows = new Set(killableLive.map((item) => item.pane?.windowName ?? item.windowIdentity));
  const wouldKillLastTeamWindow = sessionWindows.size > 0 && [...sessionWindows].every((window) => killWindows.has(window));
  if (!opts.status && !opts.dryRun && wouldKillLastTeamWindow) {
    await tmux.run("new-window", "-d", "-t", `${session}:`, "-n", TEAM_LIFECYCLE_GUARD_WINDOW);
    actions.push({ role: "session", state: "guard", action: `created ${TEAM_LIFECYCLE_GUARD_WINDOW}` });
  }

  for (const item of roster) {
    const reason = keepReason(item, keep, Boolean(opts.all));
    if (reason) {
      actions.push({ role: item.role, state: item.state, action: `keep (${reason})` });
      continue;
    }
    if (item.state !== "live") {
      actions.push({ role: item.role, state: item.state, action: `skip ${item.state}` });
      continue;
    }
    const target = item.pane?.windowName ?? item.windowIdentity;
    if (opts.status || opts.dryRun) {
      actions.push({ role: item.role, state: item.state, action: `would maw done ${target}`, target });
      continue;
    }
    if (!done) done = (await import("../done/impl")).cmdDone;
    await done(target, { sessionName: session });
    actions.push({ role: item.role, state: item.state, action: `maw done ${target}`, target });
  }

  const output = renderRoster(team, session, roster, actions, opts.dryRun ? "No changes made" : undefined);
  if (deps.logger) deps.logger(output); else console.log(output);
  return { team, session, roster, actions, output };
}
