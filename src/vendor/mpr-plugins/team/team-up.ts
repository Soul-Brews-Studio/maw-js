// Vendored copy of the team-up verb (#1976). The runtime loads THIS plugin
// (~/.maw/plugins/team → src/vendor/mpr-plugins/team), not src/commands/plugins/team.
// Paths differ from the core copy: charter is a sibling here, and commands/shared
// is three levels up (vendored dir is src/vendor/mpr-plugins/team).
import { existsSync, readFileSync } from "fs";
import { basename, resolve } from "path";
import { readTeamCharter, type TeamCharter } from "./team-charter";
import { loadConfig } from "../../../config/load";
import { ghqFind } from "maw-js/sdk";
import type { MawConfig } from "../../../config/types";
import { Tmux } from "../../../core/transport/tmux";
import type { WakeOptions } from "../../../commands/shared/wake-cmd";
import { UserError } from "../../../core/util/user-error";
import { cmdSend } from "../../../commands/shared/comm-send";
import { TEAM_LIFECYCLE_GUARD_WINDOW } from "./team-down";
import { readUnreadTeamMemberInbox, markTeamMemberInboxRead, type TeamInboxMessage } from "./team-helpers";
import {
  classifyMember,
  memberEngine,
  currentTmuxSession,
  engineCommand,
  knownTeamEngineNames,
  findRepoRoot,
  listPaneSnapshots,
  repoSlugFromRoot,
  resolveCharterPath,
  memberWakeTarget,
  memberWindowIdentity,
  wakeMember,
  isCodexLikeTeamEngine,
  type ClassifiedTeamMember,
} from "./team-liveness";

export interface TeamUpOptions {
  dryRun?: boolean;
  force?: boolean;
  status?: boolean;
  gather?: boolean;
  engine?: string;
  quick?: number;
  only?: string[];
  members?: string[];
  session?: string;
}

export interface TeamUpAction {
  role: string;
  memberKey: string;
  state: string;
  action: string;
  command?: string;
}

function memberActionKey(member: ClassifiedTeamMember, index: number): string {
  return `${member.windowIdentity}#${index}`;
}

function displayEngine(item: ClassifiedTeamMember): string {
  return item.engine ?? "(default)";
}

function resolvedMemberEngine(item: ClassifiedTeamMember, override: string | undefined, config: MawConfig): string {
  return memberEngine(item.member, override, config);
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
  cmdWakeFn?: (oracle: string, opts: WakeOptions) => Promise<string>;
  cmdSendFn?: typeof cmdSend;
  sleep?: (ms: number) => Promise<void>;
  repoRoot?: string;
  repoSlug?: string;
  projectRepoRoot?: string;
  ghqFindFn?: typeof ghqFind;
  logger?: (line: string) => void;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SHELL_RE = /^-?(zsh|bash|sh|fish)$/i;

function renderRoster(team: string, session: string, roster: ClassifiedTeamMember[], actions: TeamUpAction[], warnings: string[], tail?: string): string {
  const actionByMember = new Map(actions.map((action) => [action.memberKey, action]));
  const lines = [`team up: ${team} (${session})`, "role\tidentity\tengine\tstate\taction"];
  for (const [index, item] of roster.entries()) {
    const action = actionByMember.get(`${item.windowIdentity}#${index}`)?.action ?? "skip";
    lines.push(`${item.role}\t${item.windowIdentity}\t${displayEngine(item)}\t${item.state}\t${action}`);
  }
  if (warnings.length) lines.push("", "warnings:", ...warnings.map((warning) => `  - ${warning}`));
  if (tail) lines.push("", tail);
  return lines.join("\n");
}

async function waitForNonShell(
  member: TeamCharter["members"][number],
  session: string,
  tmux: Pick<Tmux, "run">,
  sleep: (ms: number) => Promise<void>,
  repoSlug: string,
): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const panes = await listPaneSnapshots(tmux);
    const current = classifyMember(member, panes, session, { repoSlug });
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

function memberChannels(charter: TeamCharter, member: TeamCharter["members"][number]): boolean {
  if (member.discord === false) return false;
  if (charter.discord && charter.discord !== false) return true;
  return member.channels === true;
}

function channelFlag(channels: boolean): string {
  return channels ? " --channels" : "";
}

function wakePlan(item: ClassifiedTeamMember, repoSlug: string, session: string, channels = false): string {
  if (item.member.worktree === false) {
    return `wakeable ${memberWakeTarget(repoSlug, item.member)} -e ${displayEngine(item)} --session ${session}${channelFlag(channels)}`;
  }
  return `wakeable --wt ${item.worktree} -e ${displayEngine(item)} --session ${session}${channelFlag(channels)}`;
}

function freshWakePlan(item: ClassifiedTeamMember, repoSlug: string, session: string, channels = false, prefix = "would fresh wake"): string {
  if (item.member.worktree === false) {
    return `${prefix} ${memberWakeTarget(repoSlug, item.member)} -e ${displayEngine(item)} --session ${session}${channelFlag(channels)}`;
  }
  return `${prefix} --wt ${item.worktree} -e ${displayEngine(item)} --session ${session}${channelFlag(channels)}`;
}


function normalizeProjectSlug(project: string): string {
  return project
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

async function resolveProjectRepoRoot(project: string, deps: Pick<TeamUpDeps, "projectRepoRoot" | "ghqFindFn"> = {}): Promise<string> {
  if (deps.projectRepoRoot) return deps.projectRepoRoot;
  const slug = normalizeProjectSlug(project);
  if (!slug) throw new UserError(`charter.project is empty; cannot resolve team worktree base`);
  const find = deps.ghqFindFn ?? ghqFind;
  const candidates = [`/${slug}`];
  for (const candidate of candidates) {
    const hit = await find(candidate);
    if (hit) return hit;
  }
  const repoName = basename(slug);
  throw new UserError(`charter.project '${project}' is not cloned under ghq; cannot create team worktrees. Run: ghq get github.com/${slug.includes("/") ? slug : repoName}`);
}

function resolvePrimingPrompt(member: TeamCharter["members"][number], repoRoot: string): string | undefined {
  const prompt = member.prompt?.trim();
  if (!prompt) return undefined;
  if (!prompt.startsWith("./")) return prompt;
  const path = resolve(repoRoot, prompt);
  if (!existsSync(path)) throw new Error(`prompt file not found for ${member.role}: ${prompt}`);
  return readFileSync(path, "utf-8").trim();
}

function memberPrimingTarget(session: string, member: TeamCharter["members"][number]): string {
  const identity = memberWindowIdentity(member);
  if (identity.includes(":")) return identity;
  return `${session}:${identity}`;
}



function validateRosterWorktreeIsolation(roster: ClassifiedTeamMember[], config: MawConfig, override?: string): void {
  const bad = roster
    .filter((item) => item.state !== "skipped" && item.member.worktree === false)
    .map((item) => ({ item, engine: resolvedMemberEngine(item, override, config) }))
    .filter(({ engine }) => isCodexLikeTeamEngine(engine, config))
    .map(({ item, engine }) => `${item.role}: engine '${engine}' cannot use worktree:false`);
  if (bad.length === 0) return;
  throw new UserError(`team up preflight failed: codex-like members must run in isolated worktrees (#2764): ${bad.join("; ")} — remove worktree:false or set worktree:<name>`);
}

function validateRosterEngines(roster: ClassifiedTeamMember[], charter: TeamCharter, config: MawConfig, override?: string): void {
  const known = new Set(knownTeamEngineNames(config, charter.engines));
  const bad = roster
    .filter((item) => item.state !== "skipped")
    .map((item) => ({ item, engine: resolvedMemberEngine(item, override, config) }))
    .filter(({ engine }) => !known.has(engine) && !charter.engines?.[engine])
    .map(({ item, engine }) => `${item.role}: engine '${engine}' not resolvable`);
  if (bad.length === 0) return;
  const knownList = [...known].sort().join(", ") || "none";
  throw new UserError(`team up preflight failed: unresolved member engine(s): ${bad.join("; ")} — known: [${knownList}]; define missing engines in config.engines/config.commands or charter.engines before spawning`);
}

function promptDelayMs(charter: TeamCharter): number {
  const configured = charter.lifecycle?.prompt_delay;
  return typeof configured === "number" ? configured : 3000;
}

export function quickCharter(count: number, opts: { name?: string; engine?: string; session?: string } = {}): TeamCharter {
  const safeCount = Math.max(1, Math.floor(count));
  const engine = opts.engine || "claude";
  return {
    name: opts.name || "quick",
    ...(opts.session ? { session: opts.session } : {}),
    members: Array.from({ length: safeCount }, (_, index) => {
      const n = index + 1;
      const role = `builder-${n}`;
      return { role, name: role, engine, worktree: role };
    }),
  };
}

const MAX_HANDOFF_SUMMARIES = 10;

/**
 * Render the bring-up handoff notice for a member's unread team inbox. Pure so
 * it can be tested without tmux. Lists message summaries (sender-tagged) up to
 * a cap, then an "N more" tail. Mirrors the single-oracle ψ/inbox wake notice:
 * surface what is waiting without dumping full message bodies into the pane.
 */
export function formatTeamInboxHandoff(role: string, messages: TeamInboxMessage[]): string {
  const count = messages.length;
  const header = `📬 Team handoff — ${count} unread inbox message${count === 1 ? "" : "s"} for ${role} while the team was down:`;
  const lines = messages.slice(0, MAX_HANDOFF_SUMMARIES).map((msg) => {
    const from = (msg.from ?? "").trim();
    const label = ((msg.summary ?? "").trim() || from || "message");
    return from && label !== from ? `  - [${from}] ${label}` : `  - ${label}`;
  });
  const omitted = count - lines.length;
  if (omitted > 0) lines.push(`  … ${omitted} more`);
  return [header, ...lines].join("\n");
}

/**
 * Read a member's unread team inbox (the per-role handoff written by
 * `maw team send`/`shutdown`) and render the bring-up notice, or `undefined`
 * when there is nothing waiting. Read-only and never throws — marking the
 * messages read is the caller's job, after a successful send.
 */
function takeInboxHandoff(team: string, member: TeamCharter["members"][number]): string | undefined {
  let unread: TeamInboxMessage[];
  try {
    unread = readUnreadTeamMemberInbox(team, member.role);
  } catch {
    return undefined;
  }
  return unread.length ? formatTeamInboxHandoff(member.role, unread) : undefined;
}

/**
 * Prime a freshly woken member with its charter prompt and any unread team
 * inbox handoff. Both are folded into a single send — mirroring how
 * single-oracle wake merges the ψ/inbox notice into the wake prompt
 * (mergeWakeInboxPrompt) — so the handoff never lands as a second injection
 * into a pane the prompt just set working. The inbox is marked read only after
 * the send succeeds, so a delivery failure leaves it pending for the next
 * `team up`. A missing prompt file is still a hard error (resolvePrimingPrompt
 * throws before the send), exactly as before.
 */
async function primeMember(
  member: TeamCharter["members"][number],
  session: string,
  repoRoot: string,
  team: string,
  deps: Pick<TeamUpDeps, "cmdSendFn">,
  warnings: string[],
): Promise<void> {
  const prompt = resolvePrimingPrompt(member, repoRoot);
  const handoff = takeInboxHandoff(team, member);
  const message = [prompt, handoff].filter(Boolean).join("\n\n");
  if (!message) return;
  const send = deps.cmdSendFn ?? cmdSend;
  try {
    await send(memberPrimingTarget(session, member), message, false, { currentSession: session });
    if (handoff) markTeamMemberInboxRead(team, member.role);
  } catch (error) {
    warnings.push(`prompt prime failed for ${member.role}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function cmdTeamUp(team: string, opts: TeamUpOptions = {}, deps: TeamUpDeps = {}): Promise<TeamUpResult> {
  const cwd = deps.cwd ?? process.cwd();
  const config: MawConfig = (deps.loadConfigFn ?? loadConfig)();
  const quickCount = typeof opts.quick === "number" && Number.isFinite(opts.quick) ? Math.floor(opts.quick) : undefined;
  if (quickCount !== undefined && quickCount < 1) throw new Error("--quick must be a positive integer");
  const charterPath = quickCount !== undefined ? null : (deps.charterPath !== undefined ? deps.charterPath : resolveCharterPath(team, cwd, config.node));
  if (!charterPath && quickCount === undefined) throw new Error(config.node ? `charter not found: ${team} (no team file for node '${config.node}')` : `charter not found: ${team}`);

  const read = deps.readTeamCharterFn ?? ((path: string) => quickCount !== undefined ? quickCharter(quickCount, { name: team, engine: opts.engine, session: opts.session }) : readTeamCharter(path));
  const charter: TeamCharter = read(charterPath as string);
  const tmux = deps.tmux ?? new Tmux();
  const callerRepoRoot = deps.repoRoot ?? findRepoRoot(cwd);
  const repoSlug = deps.repoSlug ?? repoSlugFromRoot(callerRepoRoot);
  const targetRepoSlug = charter.project ? normalizeProjectSlug(charter.project) : repoSlug;
  let worktreeRepoRootPromise: Promise<string> | undefined;
  const getWorktreeRepoRoot = () => {
    worktreeRepoRootPromise ??= charter.project ? resolveProjectRepoRoot(charter.project, deps) : Promise.resolve(callerRepoRoot);
    return worktreeRepoRootPromise;
  };
  const currentSession = await currentTmuxSession(tmux).catch(() => "");
  const session = opts.session?.trim() || charter.session || currentSession;
  if (!session) throw new Error(`session required: pass --session <name> when running team up outside tmux and charter.session is omitted`);
  const warnings: string[] = [];
  if (opts.session && currentSession && opts.session !== currentSession) {
    warnings.push(`current tmux session '${currentSession}' differs from --session '${opts.session}'; targeting explicit session`);
  } else if (charter.session && currentSession && charter.session !== currentSession) {
    warnings.push(`current tmux session '${currentSession}' differs from charter.session '${charter.session}'; targeting charter session`);
  }

  const panes = await listPaneSnapshots(tmux);
  const onlyItems = opts.only?.map((item) => item.trim()).filter(Boolean) ?? [];
  const only = onlyItems.length ? new Set(onlyItems) : undefined;
  const requestedMemberItems = opts.members?.map((item) => item.trim()).filter(Boolean) ?? [];
  const requestedMembers = requestedMemberItems.length ? new Set(requestedMemberItems) : undefined;
  if (requestedMembers) {
    const charterRoles = new Set(charter.members.map((member) => member.role));
    for (const role of requestedMembers) {
      if (!charterRoles.has(role)) warnings.push(`--members role not found in charter: ${role}`);
    }
  }
  const roster = charter.members.map((member) => classifyMember(member, panes, session, { engine: opts.engine, currentNode: config.node, only, members: requestedMembers, repoSlug: targetRepoSlug }));
  const actions: TeamUpAction[] = [];

  if (opts.status) {
    for (const [index, item] of roster.entries()) {
      const memberKey = memberActionKey(item, index);
      if (item.state === "skipped") actions.push({ role: item.role, memberKey, state: item.state, action: `skip (${item.skipReason ?? "guard"})` });
      else if (item.state === "missing") actions.push({ role: item.role, memberKey, state: item.state, action: wakePlan(item, targetRepoSlug, session, memberChannels(charter, item.member)) });
      else if (item.state === "dead") actions.push({ role: item.role, memberKey, state: item.state, action: "wakeable resume in place" });
      else actions.push({ role: item.role, memberKey, state: item.state, action: "skip live" });
    }
    warnOnPathCollisions(roster, warnings);
    const output = renderRoster(team, session, roster, actions, warnings);
    if (deps.logger) deps.logger(output); else console.log(output);
    return { team, session, roster, actions, warnings, output };
  }

  validateRosterEngines(roster, charter, config, opts.engine);
  validateRosterWorktreeIsolation(roster, config, opts.engine);

  if (opts.dryRun) {
    for (const [index, item] of roster.entries()) {
      const memberKey = memberActionKey(item, index);
      if (item.state === "skipped") {
        actions.push({ role: item.role, memberKey, state: item.state, action: `skip (${item.skipReason ?? "guard"})` });
      } else if (opts.force) {
        const launchEngine = resolvedMemberEngine(item, opts.engine, config);
        const command = engineCommand(launchEngine, { resume: false, engines: charter.engines }, config);
        actions.push({ role: item.role, memberKey, state: item.state, action: freshWakePlan({ ...item, engine: launchEngine }, targetRepoSlug, session, memberChannels(charter, item.member), "would force fresh wake"), command });
      } else if (item.state === "live") {
        actions.push({ role: item.role, memberKey, state: item.state, action: "skip live" });
      } else if (item.state === "dead") {
        const launchEngine = resolvedMemberEngine(item, opts.engine, config);
        const command = engineCommand(launchEngine, { resume: true, engines: charter.engines }, config);
        actions.push({ role: item.role, memberKey, state: item.state, action: "would relaunch in place with resume", command });
      } else {
        const launchEngine = resolvedMemberEngine(item, opts.engine, config);
        const command = engineCommand(launchEngine, { resume: false, engines: charter.engines }, config);
        actions.push({ role: item.role, memberKey, state: item.state, action: freshWakePlan({ ...item, engine: launchEngine }, targetRepoSlug, session, memberChannels(charter, item.member)), command });
      }
    }
    warnOnPathCollisions(roster, warnings);
    const output = renderRoster(team, session, roster, actions, warnings, "No changes made");
    if (deps.logger) deps.logger(output); else console.log(output);
    return { team, session, roster, actions, warnings, output };
  }

  const sleep = deps.sleep ?? DEFAULT_SLEEP;
  const launchTasks: Array<{ item: ClassifiedTeamMember; run: () => Promise<void> }> = [];
  for (const [index, item] of roster.entries()) {
    const memberKey = memberActionKey(item, index);
    if (item.state === "skipped") {
      actions.push({ role: item.role, memberKey, state: item.state, action: `skip (${item.skipReason ?? "guard"})` });
    } else if (opts.force) {
      const launchEngine = resolvedMemberEngine(item, opts.engine, config);
      const command = engineCommand(launchEngine, { resume: false, engines: charter.engines }, config);
      actions.push({ role: item.role, memberKey, state: item.state, action: "force fresh wake", command });
      launchTasks.push({
        item,
        run: async () => {
          if (item.pane) await tmux.run("kill-window", "-t", `${item.pane.sessionName ?? session}:${item.pane.windowName}`);
          const repoPath = await getWorktreeRepoRoot();
          await wakeMember(targetRepoSlug, item.member, { engine: launchEngine, session, repoPath, channels: memberChannels(charter, item.member) }, { cmdWakeFn: deps.cmdWakeFn });
        },
      });
    } else if (item.state === "live") {
      actions.push({ role: item.role, memberKey, state: item.state, action: "skip live" });
    } else if (item.state === "dead") {
      const launchEngine = resolvedMemberEngine(item, opts.engine, config);
      const command = engineCommand(launchEngine, { resume: true, engines: charter.engines }, config);
      actions.push({ role: item.role, memberKey, state: item.state, action: "resume in place", command });
      launchTasks.push({
        item,
        run: async () => {
          await tmux.run("send-keys", "-t", item.pane!.paneId, "C-u");
          await tmux.run("send-keys", "-t", item.pane!.paneId, command, "Enter");
        },
      });
    } else {
      const launchEngine = resolvedMemberEngine(item, opts.engine, config);
      const command = engineCommand(launchEngine, { resume: false, engines: charter.engines }, config);
      actions.push({ role: item.role, memberKey, state: item.state, action: "fresh wake", command });
      launchTasks.push({
        item,
        run: async () => {
          const repoPath = await getWorktreeRepoRoot();
          await wakeMember(targetRepoSlug, item.member, { engine: launchEngine, session, repoPath, channels: memberChannels(charter, item.member) }, { cmdWakeFn: deps.cmdWakeFn });
        },
      });
    }
  }
  await Promise.all(launchTasks.map((task) => task.run()));
  if (launchTasks.length > 0) {
    await Promise.all(launchTasks.map((task) => waitForNonShell(task.item.member, session, tmux, sleep, targetRepoSlug)));
    await sleep(promptDelayMs(charter));
    // #2742 — priming also folds in each woken member's pending team inbox so
    // messages sent while the team was down are handed off on bring-up, not
    // silently stranded in inboxes/<role>.json. Key by charter.name: that is
    // where charter prep + `maw team send` write, and it can differ from the
    // `team` argument (e.g. a charter file named after a node or alias).
    await Promise.all(launchTasks.map((task) => primeMember(task.item.member, session, callerRepoRoot, charter.name, deps, warnings)));
  }

  const finalPanes = await listPaneSnapshots(tmux).catch(() => panes);
  const finalRoster = charter.members.map((member) => classifyMember(member, finalPanes, session, { engine: opts.engine, currentNode: config.node, only, members: requestedMembers, repoSlug: targetRepoSlug }));
  warnOnPathCollisions(finalRoster, warnings);

  if (opts.gather) {
    for (const item of finalRoster) {
      if (item.pane && item.state === "live") await tmux.run("join-pane", "-s", item.pane.paneId);
    }
    await tmux.run("select-layout", "main-vertical");
    actions.push({ role: "*", memberKey: "gather", state: "live", action: "gather main-vertical" });
  }

  if (!opts.status && !opts.dryRun && finalRoster.some((item) => item.state === "live")) {
    await tmux.run("kill-window", "-t", `${session}:${TEAM_LIFECYCLE_GUARD_WINDOW}`).catch(() => undefined);
  }

  const output = renderRoster(team, session, finalRoster, actions, warnings);
  if (deps.logger) deps.logger(output); else console.log(output);
  return { team, session, roster: finalRoster, actions, warnings, output };
}
