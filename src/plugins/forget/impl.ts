import { existsSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmux, listSessions } from "maw-js/sdk";
import { findWorktrees, resolveOracle } from "maw-js/commands/shared/wake-resolve";
import { loadFleetEntries, type FleetEntry } from "maw-js/commands/shared/fleet-load";
import { cmdDone, cmdDoneAll } from "../done/impl";
import { mawConfigPath, mawStatePath } from "../../../core/xdg";

export interface ForgetOpts { dryRun?: boolean; yes?: boolean; json?: boolean }
export interface ForgetAction { layer: "worktrees"|"tmux"|"fleet"|"snapshots"|"confirm"; target: string; status: "planned"|"removed"|"skipped"|"failed"; detail?: string }
export interface ForgetResult { oracle: string; resolved: { repoPath: string; repoName: string; sessionName: string | null }; dryRun: boolean; confirmed: boolean; actions: ForgetAction[] }

const stripOracleSuffix = (name: string) => name.replace(/-oracle$/i, "");
const stripNumericPrefix = (name: string) => name.replace(/^\d+-/, "");
function aliasesFor(input: string, repoName: string): Set<string> {
  const raw = input.trim().toLowerCase(), repo = repoName.trim().toLowerCase(), bare = stripOracleSuffix(repo);
  return new Set([raw, stripOracleSuffix(raw), repo, bare].filter(Boolean));
}
function entryMatches(entry: FleetEntry, aliases: Set<string>): boolean {
  const candidates = [entry.session.name, stripNumericPrefix(entry.session.name), entry.groupName];
  for (const win of entry.session.windows || []) {
    candidates.push(win.name, stripOracleSuffix(win.name));
    if (win.repo) { const base = win.repo.split("/").pop() || win.repo; candidates.push(base, stripOracleSuffix(base)); }
  }
  return candidates.some(c => aliases.has(c.toLowerCase()));
}
function resolveFleetEntry(oracle: string, repoName: string): FleetEntry | null {
  const aliases = aliasesFor(oracle, repoName);
  const matches = loadFleetEntries().filter(e => entryMatches(e, aliases));
  if (matches.length > 1) throw new Error(`forget '${oracle}' is ambiguous in fleet: ${matches.map(m => m.session.name).join(", ")}`);
  return matches[0] ?? null;
}
async function resolveSessionName(oracle: string, repoName: string, fleetEntry: FleetEntry | null): Promise<string | null> {
  const aliases = aliasesFor(oracle, repoName); if (fleetEntry) aliases.add(fleetEntry.session.name.toLowerCase());
  const sessions = await listSessions().catch(() => [] as any[]);
  const matches = sessions.filter(s => aliases.has(s.name.toLowerCase()) || aliases.has(stripNumericPrefix(s.name).toLowerCase()));
  if (matches.length > 1) throw new Error(`forget '${oracle}' is ambiguous in tmux: ${matches.map(s => s.name).join(", ")}`);
  return matches[0]?.name ?? fleetEntry?.session.name ?? null;
}
function snapshotMatches(path: string, aliases: Set<string>, sessionName: string | null): boolean {
  try { const snap = JSON.parse(readFileSync(path, "utf-8")); return (snap.sessions || []).some((s: any) => {
    const session = String(s.name || "").toLowerCase();
    if ((sessionName && session === sessionName.toLowerCase()) || aliases.has(session) || aliases.has(stripNumericPrefix(session))) return true;
    return (s.windows || []).some((w: any) => { const win = String(w.name || "").toLowerCase(); return aliases.has(win) || aliases.has(stripOracleSuffix(win)); });
  }); } catch { return false; }
}
function matchingSnapshotFiles(oracle: string, repoName: string, sessionName: string | null): string[] {
  const aliases = aliasesFor(oracle, repoName), out: string[] = [];
  for (const dir of [...new Set([mawStatePath("snapshots"), mawConfigPath("snapshots")])]) {
    let files: string[] = []; try { files = readdirSync(dir).filter(f => f.endsWith(".json")); } catch { continue; }
    for (const file of files) { const path = join(dir, file); if (snapshotMatches(path, aliases, sessionName)) out.push(path); }
  }
  return [...new Set(out)].sort();
}
async function confirmForget(oracle: string, count: number): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`\nForget ${oracle} and remove ${count} local state item(s)? [y/N] `);
  return await new Promise<boolean>(resolve => { let buf = ""; const onData = (chunk: Buffer) => { buf += chunk.toString(); if (!buf.includes("\n")) return; process.stdin.removeListener("data", onData); process.stdin.pause(); resolve(buf.split("\n")[0]!.trim().toLowerCase() === "y"); }; process.stdin.resume(); process.stdin.on("data", onData); process.stdin.once("error", () => resolve(false)); process.stdin.once("end", () => resolve(false)); });
}
function printPlan(result: ForgetResult): void {
  console.log(`\x1b[36mforget\x1b[0m ${result.oracle} → ${result.resolved.repoName}`);
  for (const a of result.actions) console.log(`  \x1b[36m⬡\x1b[0m ${result.dryRun ? "[dry-run] would" : a.status} ${a.layer}: ${a.target}${a.detail ? ` (${a.detail})` : ""}`);
}

export async function cmdForget(oracle: string, opts: ForgetOpts = {}): Promise<ForgetResult> {
  const resolved = await resolveOracle(oracle, { quietWorktreeScan: true });
  const fleetEntry = resolveFleetEntry(oracle, resolved.repoName);
  const sessionName = await resolveSessionName(oracle, resolved.repoName, fleetEntry);
  const snapshotFiles = matchingSnapshotFiles(oracle, resolved.repoName, sessionName);
  const actions: ForgetAction[] = [{ layer: "worktrees", target: resolved.repoPath, status: "planned", detail: "maw done --all + linked worktree sweep" }];
  if (sessionName) actions.push({ layer: "tmux", target: sessionName, status: "planned", detail: "kill-session" });
  if (fleetEntry?.path) actions.push({ layer: "fleet", target: fleetEntry.path, status: "planned" });
  for (const path of snapshotFiles) actions.push({ layer: "snapshots", target: path, status: "planned" });
  let confirmed = !!opts.yes && !opts.dryRun;
  const result: ForgetResult = { oracle, resolved: { repoPath: resolved.repoPath, repoName: resolved.repoName, sessionName }, dryRun: !!opts.dryRun || !confirmed, confirmed, actions };
  if (!opts.json) printPlan(result);
  if (opts.dryRun) return result;
  if (!confirmed) { confirmed = await confirmForget(oracle, actions.length); result.confirmed = confirmed; result.dryRun = !confirmed; if (!confirmed) { actions.push({ layer: "confirm", target: oracle, status: "skipped", detail: "not confirmed; no changes made" }); if (!opts.json) console.log("  \x1b[90m○\x1b[0m not confirmed; no changes made"); return result; } }
  const mark = (layer: ForgetAction["layer"], target: string, status: ForgetAction["status"], detail?: string) => { const a = actions.find(x => x.layer === layer && x.target === target); if (a) { a.status = status; a.detail = detail ?? a.detail; } };
  try { const originalCwd = process.cwd(); try { process.chdir(resolved.repoPath); const summary = await cmdDoneAll({ oracle, force: true, cleanBranch: true, cwd: resolved.repoPath }); const remaining = await findWorktrees(resolved.parentDir, resolved.repoName); let swept = 0; for (const wt of remaining) { try { await cmdDone(wt.name, { force: true, cleanBranch: true, cwd: resolved.repoPath }); swept++; } catch { /* stale/non-maw worktree: keep going */ } } mark("worktrees", resolved.repoPath, "removed", `done --all processed ${summary.processed.length}; swept ${swept} linked worktree(s)`); } finally { if (process.cwd() !== originalCwd) process.chdir(originalCwd); } } catch (e: any) { mark("worktrees", resolved.repoPath, "failed", e?.message || String(e)); }
  if (sessionName) { try { await tmux.killSession(sessionName); mark("tmux", sessionName, "removed"); } catch (e: any) { mark("tmux", sessionName, "failed", e?.message || String(e)); } }
  if (fleetEntry?.path) { try { if (existsSync(fleetEntry.path)) unlinkSync(fleetEntry.path); mark("fleet", fleetEntry.path, "removed"); } catch (e: any) { mark("fleet", fleetEntry.path, "failed", e?.message || String(e)); } }
  for (const path of snapshotFiles) { try { if (existsSync(path)) unlinkSync(path); mark("snapshots", path, "removed"); } catch (e: any) { mark("snapshots", path, "failed", e?.message || String(e)); } }
  if (!opts.json) console.log(`  \x1b[32m✓\x1b[0m forget removed ${actions.filter(a => a.status === "removed").length} item(s)${actions.some(a => a.status === "failed") ? ", failures present" : ""}`);
  return result;
}
