import { loadConfig } from "../../../config/load";
import type { MawConfig } from "../../../config/types";
import { cmdDone, type DoneOpts } from "../../../commands/shared/done";
import { fetchGitHubPrompt } from "../../../commands/shared/wake-resolve-github";
import { cmdWake, type WakeOptions } from "../../../commands/shared/wake-cmd";
import {
  classifyMember,
  currentTmuxSession,
  findRepoRoot,
  listPaneSnapshots,
  memberMatchesSelector,
  memberEngine,
  repoSlugFromRoot,
  resolveCharterPath,
  type ClassifiedTeamMember,
} from "./team-liveness";
import { readTeamCharter } from "./team-charter";

type ReassignIssuePrompt = (num: number, repo?: string) => Promise<string>;

type ReassignWake = typeof cmdWake;

type ReassignDone = (windowName: string, opts?: DoneOpts) => Promise<void>;

export interface TeamReassignOptions {
  session?: string;
  issueRepo?: string;
  dryRun?: boolean;
}

export interface TeamReassignDeps {
  tmux?: { run: (...args: Array<string | number>) => Promise<string> };
  cwd?: string;
  charterPath?: string | null;
  readTeamCharterFn?: typeof readTeamCharter;
  loadConfigFn?: typeof loadConfig;
  cmdDoneFn?: ReassignDone;
  cmdWakeFn?: ReassignWake;
  fetchIssuePromptFn?: ReassignIssuePrompt;
  logger?: (line: string) => void;
}

export interface TeamReassignAction {
  phase: "done" | "wake";
  window: string;
  issue?: number;
}

export interface TeamReassignResult {
  team: string;
  session: string;
  member: string;
  issue: number;
  target: string;
  issueRepo?: string;
  actions: TeamReassignAction[];
  output: string;
}

function describeMemberSelector(member: ClassifiedTeamMember): string {
  return `${member.role}${member.member.name ? ` (${member.member.name})` : ""}`;
}

export async function cmdTeamReassign(
  team: string,
  selector: string,
  issueLike: number,
  opts: TeamReassignOptions = {},
  deps: TeamReassignDeps = {},
): Promise<TeamReassignResult> {
  const issue = issueLike;
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error("issue must be a positive integer");
  }

  const cwd = deps.cwd ?? process.cwd();
  const charterPath = deps.charterPath !== undefined ? deps.charterPath : resolveCharterPath(team, cwd);
  if (!charterPath) throw new Error(`team not found: ${team}`);

  const read = deps.readTeamCharterFn ?? readTeamCharter;
  const config: MawConfig = (deps.loadConfigFn ?? loadConfig)();
  const charter = read(charterPath);
  const tmux = deps.tmux;
  if (!tmux) throw new Error("tmux transport missing");

  const repoRoot = findRepoRoot(cwd);
  const repoSlug = repoSlugFromRoot(repoRoot);
  const session = opts.session?.trim() || charter.session || (await currentTmuxSession(tmux).catch(() => ""));
  if (!session) throw new Error("session required: pass --session <name> or run inside tmux");

  const rosterMembers = charter.members;
  const panes = await listPaneSnapshots(tmux);
  const classified = rosterMembers
    .map((item) => classifyMember(item, panes, session, { currentNode: config.node, repoSlug }))
    .filter((member) => {
      return memberMatchesSelector(member.member, selector);
    });

  if (!classified.length) {
    throw new Error(`member not found: ${selector}`);
  }
  if (classified.length > 1) {
    throw new Error(`member '${selector}' is ambiguous across: ${classified.map(describeMemberSelector).join(", ")}`);
  }

  const selected = classified[0]!;
  if (selected.state === "skipped") {
    throw new Error(`member '${selector}' is unavailable: ${selected.skipReason}`);
  }

  const target = selected.pane?.windowName || selected.windowIdentity;
  const actions: TeamReassignAction[] = [];
  const logger = deps.logger ?? ((line: string) => console.log(line));

  if (!opts.dryRun) {
    const done = deps.cmdDoneFn ?? cmdDone;
    const wake = deps.cmdWakeFn ?? cmdWake;

    await done(target, { sessionName: session });
    actions.push({ phase: "done", window: target });

    const fetchPrompt = deps.fetchIssuePromptFn ?? ((n: number, repo?: string) => fetchGitHubPrompt("issue", n, repo));
    const prompt = await fetchPrompt(issue, opts.issueRepo);

    const wakeOpts: WakeOptions = {
      task: `issue-${issue}`,
      prompt,
      fresh: true,
      session,
      wt: selected.member.worktree === false ? undefined : target,
      engine: memberEngine(selected.member, undefined, config),
      repoPath: repoRoot,
    };
    await wake(selected.member.name ?? selected.role, wakeOpts);
    actions.push({ phase: "wake", window: target, issue });
  }

  const lines = [
    `team reassign: ${team}`,
    `member\t${selected.role}`,
    `target\t${target}`,
    `issue\t${issue}`,
    `action\t${opts.dryRun ? "dry-run" : "done+fresh-wake+prime"}`,
    `session\t${session}`,
  ];
  const output = lines.join("\n");
  logger(output);
  return {
    team,
    session,
    member: selected.role,
    issue,
    target,
    issueRepo: opts.issueRepo,
    actions,
    output,
  };
}
