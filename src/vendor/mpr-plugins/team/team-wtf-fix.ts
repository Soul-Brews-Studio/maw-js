import { mkdirSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { DoctorCheck } from "../doctor/impl";
import type { TeamPaneSnapshot } from "./team-liveness";
import type { TeamWtfResult } from "./team-wtf";
import { inspectTeamWtf } from "./team-wtf";

export interface WtfProtectedIds {
  currentSessionId?: string;
  currentWindowId?: string;
  currentPaneId?: string;
  leadWindowIds?: string[];
}

export interface WtfFixContext {
  team: string;
  sessionName: string;
  sessionId?: string;
  protected?: WtfProtectedIds;
  cwd?: string;
}

export interface WtfFixPlanInput {
  checks: DoctorCheck[];
  context: WtfFixContext;
  confirm?: string;
}

export type WtfTransactionKind = "send-text" | "send-enter" | "done" | "kill-window" | "kill-pid" | "team-up" | "verify";

export interface WtfFixTransaction {
  kind: WtfTransactionKind;
  command: string;
  check: string;
  target?: unknown;
  signal?: "SIGTERM";
  verifyAfter?: boolean;
}

export interface WtfFixDenial {
  check: string;
  command: string;
  reason: string;
  message: string;
}

export interface WtfFixPlanResult {
  transactions: WtfFixTransaction[];
  denied: WtfFixDenial[];
  commands: string[];
}

export interface WtfFixApplyDeps {
  exec?: (command: string) => Promise<string> | string;
  inspectTeamWtfFn?: typeof inspectTeamWtf;
  archiveWipFn?: (check: DoctorCheck, context: WtfFixContext) => Promise<WipArchiveResult> | WipArchiveResult;
}

export interface WipArchiveResult {
  path: string;
  bytes: number;
  verifiedApplicable: boolean;
}

function detailsOf(check: DoctorCheck): Record<string, any> {
  return check.details && typeof check.details === "object" ? check.details as Record<string, any> : {};
}

function targetOf(check: DoctorCheck): Record<string, any> {
  const details = detailsOf(check);
  if (details.target && typeof details.target === "object") return details.target;
  if (details.pane && typeof details.pane === "object") return details.pane;
  return {};
}

function paneOf(check: DoctorCheck): TeamPaneSnapshot | undefined {
  const details = detailsOf(check);
  return details.pane && typeof details.pane === "object" ? details.pane as TeamPaneSnapshot : undefined;
}

function protectedWindowIds(context: WtfFixContext): Set<string> {
  return new Set([
    context.protected?.currentWindowId,
    ...(context.protected?.leadWindowIds ?? []),
  ].filter(Boolean) as string[]);
}

function isProtectedTarget(target: Record<string, any>, context: WtfFixContext): boolean {
  const sessionId = String(target.sessionId ?? "");
  const windowId = String(target.windowId ?? "");
  const paneId = String(target.paneId ?? "");
  if (context.protected?.currentSessionId && sessionId && sessionId === context.protected.currentSessionId && !windowId && !paneId) return true;
  if (context.protected?.currentPaneId && paneId && paneId === context.protected.currentPaneId) return true;
  return Boolean(windowId && protectedWindowIds(context).has(windowId));
}

function hasAmbiguousMatches(check: DoctorCheck): boolean {
  const details = detailsOf(check);
  const matches = Array.isArray(details.matches) ? details.matches : [];
  if (matches.length > 1) return true;
  const normalized = new Map<string, number>();
  for (const match of matches) {
    const name = String(match?.windowName ?? "");
    if (!name) continue;
    const key = name.replace(/[-_.]/g, "").toLowerCase();
    normalized.set(key, (normalized.get(key) ?? 0) + 1);
  }
  return [...normalized.values()].some((count) => count > 1);
}

function isDownAll(command: string): boolean {
  return /\bmaw\s+team\s+down\b.*\s--all(?:\s|$)/.test(command) || /\bteam\s+down\b.*\s--all(?:\s|$)/.test(command);
}

function isKillSession(command: string): boolean {
  return /\btmux\s+kill-session\b/.test(command) || /\bmaw\s+kill\s+[^\s:]+\s*$/.test(command);
}

function isDone(command: string): boolean {
  return /\bmaw\s+done\s+/.test(command);
}

function isMawKill(command: string): boolean {
  return /\bmaw\s+kill\s+/.test(command);
}

function isPidKill(command: string): boolean {
  return /^\s*(?:kill|kill\s+-TERM|kill\s+-SIGTERM)\s+\d+\s*$/.test(command);
}

function isSendText(command: string): boolean {
  return /\bmaw\s+send-text\s+%\S+\s+/.test(command);
}

function isSendEnter(command: string): boolean {
  return /\bmaw\s+send-enter\s+%\S+\s*$/.test(command);
}

function isTeamUp(command: string): boolean {
  return /\bmaw\s+team\s+up\s+/.test(command);
}

function deny(check: DoctorCheck, command: string, reason: string, message = reason): WtfFixDenial {
  return { check: check.name, command, reason, message };
}

function commandForExactDone(command: string, check: DoctorCheck): string {
  const pane = paneOf(check);
  if (pane?.windowName) return command.replace(/\bmaw\s+done\s+.+$/, `maw done ${pane.windowName}`);
  return command;
}

function commandForExactKill(command: string, check: DoctorCheck): string {
  const pane = paneOf(check);
  const target = targetOf(check);
  const sessionName = String(pane?.sessionName ?? target.sessionName ?? "");
  const windowName = String(pane?.windowName ?? target.windowName ?? "");
  if (sessionName && windowName) return `maw kill ${sessionName}:${windowName}`;
  return command;
}

function hasVerifiedWipArchive(check: DoctorCheck): boolean {
  const archive = detailsOf(check).wipArchive;
  return Boolean(archive && typeof archive === "object" && Number(archive.bytes) > 0 && archive.verifiedApplicable === true);
}

function hasStrongPidConfirm(input: WtfFixPlanInput, check: DoctorCheck): boolean {
  const pid = targetOf(check).pid;
  const confirm = input.confirm ?? "";
  return Boolean(pid && new RegExp(`\\b${pid}\\b`).test(confirm) && /sigterm|term/i.test(confirm) && /understand|confirm/i.test(confirm));
}

function addVerify(transactions: WtfFixTransaction[], check: DoctorCheck, context: WtfFixContext): void {
  transactions.push({ kind: "verify", command: `maw wtf ${context.team} --json`, check: check.name, verifyAfter: true });
}

export function planWtfFixTransactions(input: WtfFixPlanInput): WtfFixPlanResult {
  const transactions: WtfFixTransaction[] = [];
  const denied: WtfFixDenial[] = [];

  for (const check of input.checks) {
    for (const rawCommand of check.fix ?? []) {
      const command = rawCommand.trim();
      if (!command || check.ok) continue;
      const target = targetOf(check);

      if (isDownAll(command)) {
        denied.push(deny(check, command, "down --all denied", "maw wtf --fix never invokes team down --all"));
        continue;
      }
      if (hasAmbiguousMatches(check)) {
        denied.push(deny(check, command, "ambiguous normalized target collision", "refusing duplicate-name / normalized-collision target"));
        continue;
      }
      if (isProtectedTarget(target, input.context) || detailsOf(check).protectedLead === true) {
        denied.push(deny(check, command, "protected lead/current target", "refusing to modify current or charter lead target"));
        continue;
      }
      if (isKillSession(command)) {
        const targetSessionId = String(target.sessionId ?? "");
        if (targetSessionId && input.context.protected?.currentSessionId && targetSessionId === input.context.protected.currentSessionId) {
          denied.push(deny(check, command, "current session protected", "refusing to kill current/lead session"));
        } else {
          denied.push(deny(check, command, "kill-session manual only", "session teardown is not in the automatic --fix subset"));
        }
        continue;
      }
      if (isPidKill(command)) {
        const pid = Number(target.pid ?? command.match(/(\d+)\s*$/)?.[1]);
        if (!hasStrongPidConfirm(input, check)) {
          denied.push(deny(check, command, "strong confirm required for orphan pid", "orphan-pid kill is manual unless confirmed with pid and SIGTERM"));
          continue;
        }
        transactions.push({ kind: "kill-pid", command: `kill -TERM ${pid} # SIGTERM`, check: check.name, target: { ...target, pid }, signal: "SIGTERM" });
        addVerify(transactions, check, input.context);
        continue;
      }
      if (isDone(command)) {
        if (!hasVerifiedWipArchive(check)) {
          denied.push(deny(check, command, "WIP archive not verified", "teardown requires a verified non-empty applicable WIP archive first"));
          continue;
        }
        const exact = commandForExactDone(command, check);
        transactions.push({ kind: "done", command: exact, check: check.name, target });
        addVerify(transactions, check, input.context);
        continue;
      }
      if (isMawKill(command)) {
        const exact = commandForExactKill(command, check);
        if (!/:/.test(exact.replace(/^.*maw\s+kill\s+/, ""))) {
          denied.push(deny(check, command, "exact target required", "maw kill must target an exact session:window, not a bare name"));
          continue;
        }
        transactions.push({ kind: "kill-window", command: exact, check: check.name, target });
        addVerify(transactions, check, input.context);
        continue;
      }
      if (isSendText(command)) {
        transactions.push({ kind: "send-text", command, check: check.name, target });
        continue;
      }
      if (isSendEnter(command)) {
        transactions.push({ kind: "send-enter", command, check: check.name, target });
        addVerify(transactions, check, input.context);
        continue;
      }
      if (isTeamUp(command)) {
        transactions.push({ kind: "team-up", command, check: check.name, target });
        addVerify(transactions, check, input.context);
        continue;
      }

      denied.push(deny(check, command, "not allowlisted", "command is outside maw wtf --fix allowlist"));
    }
  }

  return { transactions, denied, commands: transactions.map((tx) => tx.command) };
}

export const createWtfFixPlan = planWtfFixTransactions;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function defaultExec(command: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `command failed: ${command}`);
  return stdout;
}

export async function archiveWipForCheck(check: DoctorCheck, context: WtfFixContext, deps: WtfFixApplyDeps = {}): Promise<WipArchiveResult> {
  const pane = paneOf(check);
  const cwd = pane?.path || context.cwd || process.cwd();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = check.name.replace(/[^a-z0-9_.-]+/gi, "-");
  const out = join(context.cwd || process.cwd(), "ψ", "inbox", "rescued-wip", stamp, `${safeName}.patch`);
  mkdirSync(dirname(out), { recursive: true });
  const exec = deps.exec ?? defaultExec;
  const diff = await exec(`git -C ${shellQuote(cwd)} diff --binary HEAD 2>/dev/null || true`);
  const staged = await exec(`git -C ${shellQuote(cwd)} diff --binary --cached HEAD 2>/dev/null || true`);
  const untracked = await exec(`git -C ${shellQuote(cwd)} ls-files --others --exclude-standard 2>/dev/null | sed 's/^/UNTRACKED /' || true`);
  const body = [diff, staged, untracked].filter(Boolean).join("\n");
  writeFileSync(out, body, "utf-8");
  const bytes = statSync(out).size;
  return { path: out, bytes, verifiedApplicable: bytes > 0 };
}

function checkNeedsArchive(check: DoctorCheck): boolean {
  return (check.fix ?? []).some((fix) => isDone(fix));
}

export async function enrichChecksWithWipArchives(checks: DoctorCheck[], context: WtfFixContext, deps: WtfFixApplyDeps = {}): Promise<DoctorCheck[]> {
  const enriched: DoctorCheck[] = [];
  for (const check of checks) {
    if (!checkNeedsArchive(check) || detailsOf(check).protectedLead === true) {
      enriched.push(check);
      continue;
    }
    const archive = await (deps.archiveWipFn ?? archiveWipForCheck)(check, context);
    enriched.push({ ...check, details: { ...detailsOf(check), wipArchive: archive } });
  }
  return enriched;
}

export async function applyWtfFixPlan(plan: WtfFixPlanResult, deps: WtfFixApplyDeps = {}): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  for (const tx of plan.transactions) {
    if (tx.kind === "verify") continue;
    await exec(tx.command);
  }
}

async function applyWtfFixPlanWithVerification(
  plan: WtfFixPlanResult,
  teamArg: string | undefined,
  opts: { session?: string; cwd?: string; json?: boolean },
  deps: WtfFixApplyDeps & Parameters<typeof inspectTeamWtf>[2] = {},
): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const inspect = deps.inspectTeamWtfFn ?? inspectTeamWtf;
  for (const tx of plan.transactions) {
    if (tx.kind === "verify") {
      await inspect(teamArg, { json: false, session: opts.session, cwd: opts.cwd }, deps);
      if (!opts.json) console.log(`verified after ${tx.check}: re-ran maw wtf`);
      continue;
    }
    await exec(tx.command);
  }
}

export async function cmdTeamWtfFix(teamArg: string | undefined, opts: { json?: boolean; session?: string; cwd?: string; confirm?: string; dryRun?: boolean } = {}, deps: WtfFixApplyDeps & Parameters<typeof inspectTeamWtf>[2] = {}): Promise<WtfFixPlanResult> {
  const inspect = deps.inspectTeamWtfFn ?? inspectTeamWtf;
  const first = await inspect(teamArg, { json: opts.json, session: opts.session, cwd: opts.cwd }, deps);
  const context = contextFromWtfResult(first, opts.cwd);
  const confirmed = Boolean(opts.confirm?.trim());
  const checks = confirmed && !opts.dryRun
    ? await enrichChecksWithWipArchives(first.checks, context, deps)
    : first.checks;
  const plan = planWtfFixTransactions({ checks, context, confirm: opts.confirm });
  if (opts.json) console.log(JSON.stringify(plan, null, 2));
  else renderFixPlan(plan);
  if (!opts.dryRun && !confirmed) {
    if (!opts.json) console.log("  ! no --confirm supplied; plan only (per-item confirm required by default)");
    return plan;
  }
  if (!opts.dryRun) {
    await applyWtfFixPlanWithVerification(plan, teamArg, opts, deps);
  }
  return plan;
}

export function contextFromWtfResult(result: TeamWtfResult, cwd = process.cwd()): WtfFixContext {
  const contextCheck = result.checks.find((check) => check.name === "team:context");
  const details = contextCheck ? detailsOf(contextCheck) : {};
  const leadWindowRef = String(details.leadWindowRef ?? "");
  const [leadSessionId, leadWindowId] = leadWindowRef.split(":");
  return {
    team: result.team,
    sessionName: result.session,
    sessionId: leadSessionId || undefined,
    cwd,
    protected: {
      currentSessionId: leadSessionId || undefined,
      currentWindowId: leadWindowId || undefined,
      leadWindowIds: leadWindowId ? [leadWindowId] : [],
    },
  };
}

function renderFixPlan(plan: WtfFixPlanResult): void {
  console.log("maw wtf --fix plan");
  for (const tx of plan.transactions) console.log(`  + ${tx.command}`);
  for (const item of plan.denied) console.log(`  ! denied ${item.command}: ${item.message}`);
}
