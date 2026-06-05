// Vendored copy of the team-up verb (#1976). The runtime loads THIS plugin
// (~/.maw/plugins/team → src/vendor/mpr-plugins/team), not src/commands/plugins/team.
// Paths differ from the core copy: charter is a sibling here, and commands/shared
// is three levels up (vendored dir is src/vendor/mpr-plugins/team).
import { readTeamCharter, type TeamCharter } from "./team-charter";
import { loadConfig } from "../../../config/load";
import type { MawConfig } from "../../../config/types";
import { Tmux } from "../../../core/transport/tmux";
import { cmdWake } from "../../../commands/shared/wake-cmd";
import {
  classifyMember,
  currentTmuxSession,
  engineCommand,
  findRepoRoot,
  listPaneSnapshots,
  repoSlugFromRoot,
  resolveCharterPath,
  wakeMember,
  type ClassifiedTeamMember,
} from "./team-liveness";

export interface TeamUpOptions {
  dryRun?: boolean;
  force?: boolean;
  status?: boolean;
  gather?: boolean;
  engine?: string;
}

export interface TeamUpAction {
  role: string;
  state: string;
  action: string;
  command?: string;
}

export interface TeamUpResult {
  team: string;
  session: string;
  roster: ClassifiedTeamMember[];
  actions: TeamUpAction[];
  warnings: string[];
  output: string;
}

export interface TeamUpDeps {
  tmux?: Pick<Tmux, "run">;
  cwd?: string;
  charterPath?: string | null;
  readTeamCharterFn?: typeof readTeamCharter;
  loadConfigFn?: typeof loadConfig;
  cmdWakeFn?: typeof cmdWake;
  sleep?: (ms: number) => Promise<void>;
  repoRoot?: string;
  repoSlug?: string;
  logger?: (line: string) => void;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SHELL_RE = /^-?(zsh|bash|sh|fish)$/i;

function renderRoster(team: string, session: string, roster: ClassifiedTeamMember[], actions: TeamUpAction[], warnings: string[], tail?: string): string {
  const actionByRole = new Map(actions.map((action) => [action.role, action]));
  const lines = [`team up: ${team} (${session})`, "role\tengine\tstate\taction"];
  for (const item of roster) {
    const action = actionByRole.get(item.role)?.action ?? "skip";
    lines.push(`${item.role}\t${item.engine}\t${item.state}\t${action}`);
  }
  if (warnings.length) lines.push("", "warnings:", ...warnings.map((warning) => `  - ${warning}`));
  if (tail) lines.push("", tail);
  return lines.join("\n");
}

async function waitForNonShell(
  role: string,
  session: string,
  tmux: Pick<Tmux, "run">,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const panes = await listPaneSnapshots(tmux);
    const current = classifyMember({ role }, panes, session);
    if (current.pane && !SHELL_RE.test(current.pane.command)) return;
    await sleep(1000);
  }
}

function warnOnPathCollisions(roster: ClassifiedTeamMember[], warnings: string[]): void {
  const seen = new Map<string, string>();
  for (const item of roster) {
    if (!item.member.worktree || !item.pane?.path) continue;
    const prior = seen.get(item.pane.path);
    if (prior && prior !== item.role) warnings.push(`worktree path collision: ${prior} and ${item.role} both at ${item.pane.path}`);
    else seen.set(item.pane.path, item.role);
  }
}

export async function cmdTeamUp(team: string, opts: TeamUpOptions = {}, deps: TeamUpDeps = {}): Promise<TeamUpResult> {
  const cwd = deps.cwd ?? process.cwd();
  const charterPath = deps.charterPath !== undefined ? deps.charterPath : resolveCharterPath(team, cwd);
  if (!charterPath) throw new Error(`charter not found: ${team}`);

  const read = deps.readTeamCharterFn ?? readTeamCharter;
  const charter: TeamCharter = read(charterPath);
  const tmux = deps.tmux ?? new Tmux();
  const config: MawConfig = (deps.loadConfigFn ?? loadConfig)();
  const repoRoot = deps.repoRoot ?? findRepoRoot(cwd);
  const repoSlug = deps.repoSlug ?? repoSlugFromRoot(repoRoot);
  const currentSession = await currentTmuxSession(tmux).catch(() => "");
  const session = charter.session ?? currentSession;
  const warnings: string[] = [];
  if (charter.session && currentSession && charter.session !== currentSession) {
    warnings.push(`current tmux session '${currentSession}' differs from charter.session '${charter.session}'; targeting charter session`);
  }

  const panes = await listPaneSnapshots(tmux);
  const roster = charter.members.map((member) => classifyMember(member, panes, session, { engine: opts.engine }));
  const actions: TeamUpAction[] = [];

  if (opts.status) {
    warnOnPathCollisions(roster, warnings);
    const output = renderRoster(team, session, roster, actions, warnings);
    if (deps.logger) deps.logger(output); else console.log(output);
    return { team, session, roster, actions, warnings, output };
  }

  if (opts.dryRun) {
    for (const item of roster) {
      if (opts.force) {
        const command = engineCommand(item.engine, { resume: false }, config);
        actions.push({ role: item.role, state: item.state, action: `would force fresh wake --wt ${item.worktree} -e ${item.engine} --session ${session}`, command });
      } else if (item.state === "live") {
        actions.push({ role: item.role, state: item.state, action: "skip live" });
      } else if (item.state === "dead") {
        const command = engineCommand(item.engine, { resume: true }, config);
        actions.push({ role: item.role, state: item.state, action: "would relaunch in place with resume", command });
      } else {
        const command = engineCommand(item.engine, { resume: false }, config);
        actions.push({ role: item.role, state: item.state, action: `would fresh wake --wt ${item.worktree} -e ${item.engine} --session ${session}`, command });
      }
    }
    warnOnPathCollisions(roster, warnings);
    const output = renderRoster(team, session, roster, actions, warnings, "No changes made");
    if (deps.logger) deps.logger(output); else console.log(output);
    return { team, session, roster, actions, warnings, output };
  }

  const sleep = deps.sleep ?? DEFAULT_SLEEP;
  for (const item of roster) {
    if (opts.force) {
      if (item.pane) await tmux.run("kill-window", "-t", `${item.pane.sessionName ?? session}:${item.pane.windowName}`);
      const command = engineCommand(item.engine, { resume: false }, config);
      await wakeMember(repoSlug, item.member, { engine: item.engine, session, repoPath: repoRoot }, { cmdWakeFn: deps.cmdWakeFn });
      actions.push({ role: item.role, state: item.state, action: "force fresh wake", command });
      await waitForNonShell(item.role, session, tmux, sleep);
    } else if (item.state === "live") {
      actions.push({ role: item.role, state: item.state, action: "skip live" });
    } else if (item.state === "dead") {
      const command = engineCommand(item.engine, { resume: true }, config);
      await tmux.run("send-keys", "-t", item.pane!.paneId, command, "Enter");
      actions.push({ role: item.role, state: item.state, action: "resume in place", command });
      await waitForNonShell(item.role, session, tmux, sleep);
    } else {
      const command = engineCommand(item.engine, { resume: false }, config);
      await wakeMember(repoSlug, item.member, { engine: item.engine, session, repoPath: repoRoot }, { cmdWakeFn: deps.cmdWakeFn });
      actions.push({ role: item.role, state: item.state, action: "fresh wake", command });
      await waitForNonShell(item.role, session, tmux, sleep);
    }
  }

  const finalPanes = await listPaneSnapshots(tmux).catch(() => panes);
  const finalRoster = charter.members.map((member) => classifyMember(member, finalPanes, session, { engine: opts.engine }));
  warnOnPathCollisions(finalRoster, warnings);

  if (opts.gather) {
    for (const item of finalRoster) {
      if (item.pane && item.state === "live") await tmux.run("join-pane", "-s", item.pane.paneId);
    }
    await tmux.run("select-layout", "main-vertical");
    actions.push({ role: "*", state: "live", action: "gather main-vertical" });
  }

  const output = renderRoster(team, session, finalRoster, actions, warnings);
  if (deps.logger) deps.logger(output); else console.log(output);
  return { team, session, roster: finalRoster, actions, warnings, output };
}
