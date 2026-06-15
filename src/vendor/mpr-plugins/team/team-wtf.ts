import type { DoctorCheck } from "../doctor/impl";
import { loadConfig } from "../../../config/load";
import { resolveEngine } from "../../../config/engine-registry";
import { UserError } from "../../../core/util/user-error";
import { Tmux } from "../../../core/transport/tmux";
import type { MawConfig } from "../../../config/types";
import {
  classifyMember,
  currentTmuxSession,
  listPaneSnapshots,
  memberEngineForClassification,
  memberWindowCandidates,
  memberWindowIdentity,
  oracleStemFromRepoSlug,
  repoSlugFromRoot,
  resolveCharterPath,
  type TeamPaneSnapshot,
} from "./team-liveness";
import { readTeamCharter, type TeamCharter, type TeamCharterMember } from "./team-charter";

export type TeamWtfVerb = "up" | "done" | "kill" | "send-text" | "report" | "leave" | "none";

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid?: number;
  args: string;
}

export interface PaneProcessBinding {
  pane: TeamPaneSnapshot;
  processes: ProcessRow[];
  engineProcesses: ProcessRow[];
}

export interface ProcessMapSample {
  byPaneId: Map<string, PaneProcessBinding>;
  rows: ProcessRow[];
}

export interface TeamWtfProcessDeps {
  ps?: () => Promise<ProcessRow[]> | ProcessRow[];
  /** Optional cwd lookup for future corroboration. Not used as the binding key. */
  lsofCwd?: (pid: number) => Promise<string | undefined> | string | undefined;
}

export interface TeamWtfDeps extends TeamWtfProcessDeps {
  tmux?: Pick<Tmux, "run">;
  listPaneSnapshotsFn?: typeof listPaneSnapshots;
  currentTmuxSessionFn?: typeof currentTmuxSession;
  resolveCharterPathFn?: typeof resolveCharterPath;
  readTeamCharterFn?: typeof readTeamCharter;
  loadConfigFn?: typeof loadConfig;
  currentWindowRefFn?: (tmux: Pick<Tmux, "run">) => Promise<string | undefined> | string | undefined;
  processSampleCount?: number;
}

export interface TeamWtfOptions {
  json?: boolean;
  session?: string;
  cwd?: string;
  /** Test-only: one sample is intentionally UNKNOWN for negative BUSY evidence. */
  processSampleCount?: number;
}

export interface TeamWtfResult {
  ok: boolean;
  team: string;
  session: string;
  charterPath: string;
  checks: DoctorCheck[];
}

const PROMPT_RE = /(?:do you trust|yes, continue|allow\?|allow\s+\[?y|\(y\/n\)|\[y\/n\]|permission|approval)/i;

function stripNumberedSessionPrefix(session: string): string {
  return session.replace(/^\d+-/, "");
}

export function detectTeamNameFromSession(session: string): string {
  return stripNumberedSessionPrefix(session.trim());
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function processBasename(args: string): string {
  const first = args.trim().split(/\s+/)[0] || "";
  return first.split(/[\\/]/).pop() || first;
}

function matchesProcessName(row: ProcessRow, names: readonly string[]): boolean {
  const base = processBasename(row.args);
  return names.some((name) => {
    const wanted = name.trim();
    if (!wanted) return false;
    const wantedBase = wanted.split(/[\\/]/).pop() || wanted;
    return base === wantedBase || row.args.includes(`/${wantedBase} `) || row.args.endsWith(`/${wantedBase}`);
  });
}

function descendantsOf(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const descendants: ProcessRow[] = [];
  for (const row of rows) {
    let cursor = row.ppid;
    const seen = new Set<number>([row.pid]);
    while (cursor && !seen.has(cursor)) {
      if (cursor === rootPid) {
        descendants.push(row);
        break;
      }
      seen.add(cursor);
      cursor = byPid.get(cursor)?.ppid ?? 0;
    }
  }
  return descendants;
}

function engineProcessNames(engine: string | undefined, config: MawConfig): string[] {
  if (!engine) {
    const names: string[] = [];
    for (const key of Object.keys(config.engines ?? {})) {
      try { names.push(...(resolveEngine(key, config).processNames ?? [])); } catch { /* ignore bad config entry */ }
    }
    for (const key of Object.keys(config.commands ?? {})) {
      try { names.push(...(resolveEngine(key, config).processNames ?? [])); } catch { /* ignore bad config entry */ }
    }
    return [...new Set(names.filter(Boolean))];
  }
  try {
    return [...new Set((resolveEngine(engine, config).processNames ?? []).filter(Boolean))];
  } catch {
    return [];
  }
}

async function defaultPs(): Promise<ProcessRow[]> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,args="], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0) return [];
  return parsePs(stdout);
}

export function parsePs(raw: string): ProcessRow[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), args: match[4] ?? "" }];
  });
}

export async function sampleProcessMap(
  panes: TeamPaneSnapshot[],
  engineNames: readonly string[],
  deps: TeamWtfProcessDeps = {},
): Promise<ProcessMapSample> {
  const rows = await (deps.ps ?? defaultPs)();
  const byPaneId = new Map<string, PaneProcessBinding>();
  for (const pane of panes) {
    const panePid = Number(pane.panePid ?? 0);
    if (!pane.paneId || !Number.isFinite(panePid) || panePid <= 0) continue;
    const processes = descendantsOf(rows, panePid);
    const engineProcesses = processes.filter((row) => matchesProcessName(row, engineNames));
    byPaneId.set(pane.paneId, { pane, processes, engineProcesses });
  }
  return { byPaneId, rows };
}

async function doubleSampleProcessMap(
  panes: TeamPaneSnapshot[],
  engineNames: readonly string[],
  deps: TeamWtfDeps,
  sampleCount: number,
): Promise<ProcessMapSample[]> {
  const samples: ProcessMapSample[] = [];
  for (let i = 0; i < Math.max(1, sampleCount); i++) {
    samples.push(await sampleProcessMap(panes, engineNames, deps));
  }
  return samples;
}

function matchingEngineCount(sample: ProcessMapSample, paneId: string, names: readonly string[]): number {
  return (sample.byPaneId.get(paneId)?.processes ?? []).filter((row) => matchesProcessName(row, names)).length;
}

function allSamplesHaveEngine(samples: ProcessMapSample[], paneId: string, names: readonly string[]): boolean {
  return samples.length >= 2 && samples.every((sample) => matchingEngineCount(sample, paneId, names) > 0);
}

function allSamplesHaveNoEngine(samples: ProcessMapSample[], paneId: string, names: readonly string[]): boolean {
  return samples.length >= 2 && samples.every((sample) => sample.byPaneId.has(paneId) && matchingEngineCount(sample, paneId, names) === 0);
}

function memberTarget(member: TeamCharterMember): string {
  return memberWindowIdentity(member);
}

function reviveVerb(team: string, member: TeamCharterMember): string {
  return `maw team up ${team} --only ${member.role}`;
}

function paneWindowRef(pane: TeamPaneSnapshot): string | undefined {
  return pane.sessionId && pane.windowId ? `${pane.sessionId}:${pane.windowId}` : undefined;
}

function isLeadPane(pane: TeamPaneSnapshot, leadWindowRef: string | undefined): boolean {
  const ref = paneWindowRef(pane);
  return Boolean(ref && leadWindowRef && ref === leadWindowRef);
}

async function currentWindowRef(tmux: Pick<Tmux, "run">): Promise<string | undefined> {
  const ref = (await tmux.run("display-message", "-p", "#{session_id}:#{window_id}")).trim();
  return ref || undefined;
}

function exactPaneTarget(pane: TeamPaneSnapshot): string {
  return `${pane.sessionName}:${pane.windowName}`;
}

function memberCheckName(member: TeamCharterMember, suffix = "state"): string {
  return `team:${member.role}:${suffix}`;
}

function diagnoseMember(opts: {
  team: string;
  member: TeamCharterMember;
  panes: TeamPaneSnapshot[];
  samples: ProcessMapSample[];
  repoSlug: string;
  session: string;
  config: MawConfig;
  leadWindowRef?: string;
}): DoctorCheck {
  const { team, member, panes, samples, repoSlug, session, config, leadWindowRef } = opts;
  const classified = classifyMember(member, panes, session, { repoSlug, currentNode: config.node });
  const identity = memberTarget(member);

  if (classified.state === "skipped") {
    return {
      name: memberCheckName(member, "off-node"),
      ok: true,
      severity: "info",
      message: `${identity}: off-node (${classified.skipReason}); report only`,
      fix: [],
      details: { role: member.role, state: "off-node", verb: "report" satisfies TeamWtfVerb },
    };
  }

  if (classified.state === "missing") {
    return {
      name: memberCheckName(member),
      ok: false,
      severity: "warn",
      message: `${identity}: missing from ${session}; rehydrate from charter`,
      fix: [reviveVerb(team, member)],
      details: { role: member.role, state: "missing", verb: "up" satisfies TeamWtfVerb },
    };
  }

  const pane = classified.pane;
  if (!pane) {
    return {
      name: memberCheckName(member),
      ok: false,
      severity: "warn",
      message: `${identity}: unknown pane state`,
      fix: [],
      details: { role: member.role, state: "unknown", verb: "none" satisfies TeamWtfVerb },
    };
  }

  const protectedLead = isLeadPane(pane, leadWindowRef);

  const candidates = memberWindowCandidates(member, repoSlug);
  const exactOrSuffix = candidates.some((candidate) => pane.windowName === candidate || new RegExp(`-${escapeRegex(candidate)}$`).test(pane.windowName));
  if (!exactOrSuffix) {
    return {
      name: memberCheckName(member, "wrong-name"),
      ok: false,
      severity: "error",
      message: `${identity}: wrong-name window '${pane.windowName}'`,
      fix: protectedLead ? [] : [`archive WIP for ${pane.windowName}`, `maw done ${pane.windowName}`, reviveVerb(team, member)],
      details: { role: member.role, state: "wrong-name", pane, protectedLead, verb: protectedLead ? "none" : "done" satisfies TeamWtfVerb },
    };
  }

  if (classified.state === "dead") {
    return {
      name: memberCheckName(member, "dead-frame"),
      ok: false,
      severity: "error",
      message: protectedLead ? `${identity}: dead-frame (${pane.command || "shell"}); lead protected` : `${identity}: dead-frame (${pane.command || "shell"})`,
      fix: protectedLead ? [] : [`archive WIP for ${identity}`, `maw done ${identity}`],
      details: { role: member.role, state: "dead-frame", pane, protectedLead, verb: protectedLead ? "none" : "done" satisfies TeamWtfVerb },
    };
  }

  const engine = memberEngineForClassification(member);
  const names = engineProcessNames(engine, config);
  if (PROMPT_RE.test(`${pane.command}\n${pane.path}`)) {
    return {
      name: memberCheckName(member, "blocked-prompt"),
      ok: false,
      severity: "warn",
      message: `${identity}: possible stuck trust/permission prompt`,
      fix: [`maw send-text ${pane.paneId} y`, `maw send-enter ${pane.paneId}`],
      details: { role: member.role, state: "blocked-prompt", pane, verb: "send-text" satisfies TeamWtfVerb },
    };
  }

  if (names.length === 0 || !pane.panePid || samples.length < 2) {
    return {
      name: memberCheckName(member, "unknown-busy"),
      ok: false,
      severity: "warn",
      message: `${identity}: live pane but process map is unknown (needs two samples and engine processNames)`,
      fix: [],
      details: { role: member.role, state: "unknown", pane, engine, processNames: names, verb: "none" satisfies TeamWtfVerb },
    };
  }

  if (allSamplesHaveEngine(samples, pane.paneId, names)) {
    return {
      name: memberCheckName(member),
      ok: true,
      severity: "info",
      message: `${identity}: aligned; engine descendant present`,
      fix: [],
      details: { role: member.role, state: "aligned", pane, engine, processNames: names, verb: "leave" satisfies TeamWtfVerb },
    };
  }

  if (allSamplesHaveNoEngine(samples, pane.paneId, names)) {
    return {
      name: memberCheckName(member, "dead-frame"),
      ok: false,
      severity: "error",
      message: protectedLead ? `${identity}: dead-frame; lead protected; no ${engine ?? "engine"} descendant under pane pid ${pane.panePid} in two samples` : `${identity}: dead-frame; no ${engine ?? "engine"} descendant under pane pid ${pane.panePid} in two samples`,
      fix: protectedLead ? [] : [`archive WIP for ${identity}`, `maw done ${identity}`],
      details: { role: member.role, state: "dead-frame", pane, engine, processNames: names, protectedLead, verb: protectedLead ? "none" : "done" satisfies TeamWtfVerb },
    };
  }

  return {
    name: memberCheckName(member, "unknown-busy"),
    ok: false,
    severity: "warn",
    message: `${identity}: process map changed between samples; not safe to classify`,
    fix: [],
    details: { role: member.role, state: "unknown", pane, engine, processNames: names, verb: "none" satisfies TeamWtfVerb },
  };
}

function paneMatchesDeclaredMember(pane: TeamPaneSnapshot, charter: TeamCharter, repoSlug: string): boolean {
  return charter.members.some((member) => memberWindowCandidates(member, repoSlug).some((candidate) =>
    pane.windowName === candidate || new RegExp(`-${escapeRegex(candidate)}$`).test(pane.windowName)
  ));
}

function orphanChecks(team: string, charter: TeamCharter, panes: TeamPaneSnapshot[], session: string, repoSlug: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const pane of panes.filter((pane) => pane.sessionName === session)) {
    if (!pane.windowName || paneMatchesDeclaredMember(pane, charter, repoSlug)) continue;
    const likelyTeamWindow = pane.windowName.includes(oracleStemFromRepoSlug(repoSlug)) || pane.windowName.includes(team);
    if (!likelyTeamWindow) continue;
    checks.push({
      name: `team:orphan:${pane.windowName}`,
      ok: false,
      severity: "warn",
      message: `${pane.windowName}: extra team-looking window not declared in charter`,
      fix: [`maw kill ${exactPaneTarget(pane)}`],
      details: { state: "orphan", pane, verb: "kill" satisfies TeamWtfVerb },
    });
  }
  return checks;
}

export async function inspectTeamWtf(teamArg: string | undefined, opts: TeamWtfOptions = {}, deps: TeamWtfDeps = {}): Promise<TeamWtfResult> {
  const cwd = opts.cwd ?? process.cwd();
  const tmux = deps.tmux ?? new Tmux();
  const session = opts.session || (teamArg ? "" : await (deps.currentTmuxSessionFn ?? currentTmuxSession)(tmux));
  const team = (teamArg?.trim() || detectTeamNameFromSession(session)).trim();
  if (!team) throw new UserError("maw wtf: not in a tmux team session; pass an explicit team: maw wtf <team>");
  const config = (deps.loadConfigFn ?? loadConfig)({ cwd });
  const charterPath = (deps.resolveCharterPathFn ?? resolveCharterPath)(team, cwd, config.node);
  if (!charterPath) throw new UserError(`maw wtf: no charter found for '${team}' from ${cwd}`);
  const charter = (deps.readTeamCharterFn ?? readTeamCharter)(charterPath);
  const effectiveSession = opts.session || charter.session || session || team;
  if (!effectiveSession) throw new UserError("maw wtf: no tmux session detected; pass an explicit team inside a repo with a charter session");
  const panes = await (deps.listPaneSnapshotsFn ?? listPaneSnapshots)(tmux);
  const leadWindowRef = await (deps.currentWindowRefFn ?? currentWindowRef)(tmux).catch(() => undefined);
  const repoSlug = charter.project || repoSlugFromRoot(cwd);

  const allProcessNames = [...new Set(charter.members.flatMap((member) => engineProcessNames(memberEngineForClassification(member), config)))];
  const samples = await doubleSampleProcessMap(panes, allProcessNames, deps, opts.processSampleCount ?? deps.processSampleCount ?? 2).catch(() => []);

  const checks: DoctorCheck[] = [
    {
      name: "team:context",
      ok: true,
      severity: "info",
      message: `TEAM ${team} charter: ${charterPath} session: ${effectiveSession}`,
      fix: [],
      details: { team, charterPath, session: effectiveSession, repoSlug, leadWindowRef },
    },
    ...charter.members.map((member) => diagnoseMember({ team, member, panes, samples, repoSlug, session: effectiveSession, config, leadWindowRef })),
    ...orphanChecks(team, charter, panes, effectiveSession, repoSlug),
  ];
  const ok = checks.every((check) => check.ok || check.severity === "info");
  return { ok, team, session: effectiveSession, charterPath, checks };
}

function renderChecks(result: TeamWtfResult): void {
  const issues = result.checks.filter((check) => !check.ok || check.severity === "warn");
  if (issues.length === 0) {
    const aligned = result.checks.filter((check) => check.name.startsWith("team:") && check.name.endsWith(":state") && check.ok).length;
    console.log(`✅ ${aligned} aligned, lead protected`);
    return;
  }
  console.log(`TEAM ${result.team}   charter: ${result.charterPath}   session: ${result.session}`);
  console.log("member/check                 status  diagnosis");
  for (const check of result.checks.filter((check) => check.name !== "team:context")) {
    const icon = check.ok ? "✅" : check.severity === "warn" ? "⚠️" : "❌";
    console.log(`${icon} ${check.name.padEnd(26)} ${check.message}`);
    for (const fix of check.fix ?? []) console.log(`   → ${fix}`);
  }
}

export async function cmdTeamWtf(teamArg?: string, opts: TeamWtfOptions = {}, deps: TeamWtfDeps = {}): Promise<TeamWtfResult> {
  const result = await inspectTeamWtf(teamArg, opts, deps);
  if (opts.json) console.log(JSON.stringify({ ok: result.ok, checks: result.checks }, null, 2));
  else renderChecks(result);
  return result;
}
