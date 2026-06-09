// Charter-driven team apply (#2612). Dry-run by default; --apply mutates.
import { existsSync } from "fs";
import { basename } from "path";
import { isAgentCommand } from "../../../core/agent-detect";
import { loadConfig } from "../../../config/load";
import type { MawConfig } from "../../../config/types";
import { Tmux } from "../../../core/transport/tmux";
import { cmdDone } from "../done/impl";
import { readTeamCharter, type TeamCharter, type TeamCharterMember } from "./team-charter";
import { TEAM_LIFECYCLE_GUARD_WINDOW } from "./team-down";
import {
  classifyMember,
  currentTmuxSession,
  engineCommand,
  findRepoRoot,
  listPaneSnapshots,
  memberWindowCandidates,
  repoSlugFromRoot,
  resolveCharterPath,
  wakeMember,
  type ClassifiedTeamMember,
  type TeamPaneSnapshot,
  type WakeMemberDeps,
} from "./team-liveness";

export interface TeamApplyOptions {
  apply?: boolean;
  session?: string;
  charterPath?: string;
}

export type TeamApplyActionKind = "spawn" | "shutdown" | "report" | "skip";

export interface TeamApplyAction {
  kind: TeamApplyActionKind;
  role: string;
  state: string;
  action: string;
  target?: string;
  detail?: string;
  command?: string;
}

export interface TeamApplyResult {
  team: string;
  session: string;
  charter: TeamCharter;
  roster: ClassifiedTeamMember[];
  removed: TeamPaneSnapshot[];
  actions: TeamApplyAction[];
  warnings: string[];
  output: string;
}

export interface TeamApplyDeps {
  tmux?: Pick<Tmux, "run">;
  cwd?: string;
  readTeamCharterFn?: typeof readTeamCharter;
  loadConfigFn?: typeof loadConfig;
  cmdWakeFn?: WakeMemberDeps["cmdWakeFn"];
  cmdDoneFn?: typeof cmdDone;
  branchForPathFn?: (path: string) => string | undefined;
  repoRoot?: string;
  repoSlug?: string;
  logger?: (line: string) => void;
}

function resolveApplyCharterPath(teamOrPath: string, cwd: string, config: MawConfig, explicit?: string): string | null {
  if (explicit) return explicit;
  if (existsSync(teamOrPath)) return teamOrPath;
  return resolveCharterPath(teamOrPath, cwd, config.node);
}

function charterNameFromInput(teamOrPath: string, charter: TeamCharter): string {
  return charter.name || basename(teamOrPath).replace(/\.(ya?ml|json)$/i, "");
}

function paneMatchesAnyMember(pane: TeamPaneSnapshot, members: TeamCharterMember[], repoSlug: string): boolean {
  for (const member of members) {
    const candidates = memberWindowCandidates(member, repoSlug);
    if (candidates.includes(pane.windowName)) return true;
    if (candidates.some((candidate) => pane.windowName.endsWith(`-${candidate}`))) return true;
  }
  return false;
}

function currentBranch(path: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", "-C", path, "branch", "--show-current"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return undefined;
    return new TextDecoder().decode(proc.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

function engineLooksSame(liveCommand: string, expectedCommand: string, engine: string): boolean {
  const live = liveCommand.trim();
  if (!live) return false;
  const expectedHead = expectedCommand.trim().split(/\s+/, 1)[0] ?? "";
  return live === engine || live === expectedHead || live.includes(engine) || (!!expectedHead && live.includes(expectedHead));
}

function renderApply(result: Omit<TeamApplyResult, "output">, apply: boolean): string {
  const mode = apply ? "apply" : "dry-run";
  const lines = [`team apply: ${result.team} (${result.session}) ${mode}`, "kind\trole\tstate\taction"];
  for (const action of result.actions) {
    lines.push(`${action.kind}\t${action.role}\t${action.state}\t${action.action}`);
  }
  if (result.warnings.length) lines.push("", "warnings:", ...result.warnings.map((warning) => `  - ${warning}`));
  if (!apply) lines.push("", "No changes made (pass --apply to execute)");
  return lines.join("\n");
}

export async function cmdTeamApply(teamOrPath: string, opts: TeamApplyOptions = {}, deps: TeamApplyDeps = {}): Promise<TeamApplyResult> {
  const cwd = deps.cwd ?? process.cwd();
  const config: MawConfig = (deps.loadConfigFn ?? loadConfig)();
  const charterPath = resolveApplyCharterPath(teamOrPath, cwd, config, opts.charterPath);
  if (!charterPath) throw new Error(config.node ? `charter not found: ${teamOrPath} (no team file for node '${config.node}')` : `charter not found: ${teamOrPath}`);

  const charter = (deps.readTeamCharterFn ?? readTeamCharter)(charterPath);
  const team = charterNameFromInput(teamOrPath, charter);
  const tmux = deps.tmux ?? new Tmux();
  const repoRoot = deps.repoRoot ?? findRepoRoot(cwd);
  const repoSlug = deps.repoSlug ?? repoSlugFromRoot(repoRoot);
  const targetRepoSlug = charter.project ?? repoSlug;
  const currentSession = await currentTmuxSession(tmux).catch(() => "");
  const session = opts.session?.trim() || charter.session || currentSession;
  if (!session) throw new Error("session required: pass --session <name> when running team apply outside tmux and charter.session is omitted");

  const panes = await listPaneSnapshots(tmux);
  const roster = charter.members.map((member) => classifyMember(member, panes, session, { currentNode: config.node, repoSlug: targetRepoSlug }));
  const warnings: string[] = [];
  const actions: TeamApplyAction[] = [];
  const branchForPath = deps.branchForPathFn ?? currentBranch;

  const removed = panes.filter((pane) =>
    pane.sessionName === session &&
    pane.windowName !== TEAM_LIFECYCLE_GUARD_WINDOW &&
    isAgentCommand(pane.command) &&
    !paneMatchesAnyMember(pane, charter.members, targetRepoSlug)
  );

  for (const item of roster) {
    if (item.state === "skipped") {
      actions.push({ kind: "skip", role: item.role, state: item.state, action: `skip (${item.skipReason ?? "guard"})` });
      continue;
    }
    if (item.state === "missing") {
      const command = engineCommand(item.engine, { resume: false, engines: charter.engines }, config);
      actions.push({ kind: "spawn", role: item.role, state: item.state, action: opts.apply ? "spawn member" : "would spawn member", command });
      if (opts.apply) {
        await wakeMember(targetRepoSlug, item.member, { engine: item.engine, session, repoPath: repoRoot, channels: item.member.channels === true }, { cmdWakeFn: deps.cmdWakeFn });
      }
      continue;
    }
    if (item.state === "dead") {
      actions.push({ kind: "skip", role: item.role, state: item.state, action: "skip dead member (team up can resume)" });
      continue;
    }

    const expectedCommand = engineCommand(item.engine, { resume: false, engines: charter.engines }, config);
    if (item.member.engine && item.pane && !engineLooksSame(item.pane.command, expectedCommand, item.engine)) {
      actions.push({
        kind: "report",
        role: item.role,
        state: item.state,
        action: "engine changed; not migrated",
        detail: `live=${item.pane.command} charter=${item.engine}`,
      });
    } else {
      actions.push({ kind: "skip", role: item.role, state: item.state, action: "skip live" });
    }

    if (item.member.branch && item.pane?.path) {
      const liveBranch = branchForPath(item.pane.path);
      if (liveBranch && liveBranch !== item.member.branch) {
        actions.push({
          kind: "report",
          role: item.role,
          state: item.state,
          action: "branch changed; not migrated",
          detail: `live=${liveBranch} charter=${item.member.branch}`,
        });
      }
    }
  }

  const done = deps.cmdDoneFn ?? cmdDone;
  for (const pane of removed) {
    const role = pane.windowName;
    const action = opts.apply ? "maw done removed member" : "would maw done removed member";
    actions.push({ kind: "shutdown", role, state: "extra", action, target: pane.windowName });
    if (opts.apply) await done(pane.windowName, { sessionName: session });
  }

  if (!removed.length && !roster.some((item) => item.state === "missing")) {
    warnings.push("no spawn/shutdown changes detected");
  }

  const resultBase = { team, session, charter, roster, removed, actions, warnings };
  const output = renderApply(resultBase, Boolean(opts.apply));
  const result = { ...resultBase, output };
  if (deps.logger) deps.logger(output); else console.log(output);
  return result;
}
