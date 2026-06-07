import { resolveByName } from "../../core/matcher/resolve-target";

export const PANE_TARGET_FORMAT = "#{pane_id}|||#{session_name}:#{window_index}.#{pane_index}|||#{pane_title}|||#{@maw_tile_role}|||#{pane_current_path}";

export interface PaneTargetCandidate {
  name: string;
  resolved: string;
  source: string;
  target: string;
}

export type PaneTargetResolution =
  | { kind: "none" }
  | { kind: "match"; candidate: PaneTargetCandidate }
  | { kind: "ambiguous"; candidates: PaneTargetCandidate[] };


function worktreeNamesFromCwd(cwd: string): Array<{ name: string; source: string }> {
  const parts = cwd.split("/").filter(Boolean);
  const base = parts.at(-1) || "";
  if (!base) return [];
  const out: Array<{ name: string; source: string }> = [{ name: base, source: "worktree-dir" }];

  if (parts.at(-2) === "agents") {
    const role = base.replace(/^\d+-/, "");
    const repo = parts.at(-3)?.trim();
    if (role && role !== base) out.push({ name: role, source: "worktree-role" });
    const repoStem = repo?.replace(/-oracle$/, "");
    if (repoStem && role) out.push({ name: `${repoStem}-${role}`, source: "worktree-alias" });
    return out;
  }

  const match = base.match(/^(?<repo>.+)\.wt-\d+-(?<role>.+)$/);
  const role = match?.groups?.role?.trim();
  const repo = match?.groups?.repo?.trim();
  if (role) {
    out.push({ name: role, source: "worktree-role" });
    // Natural user target for repo worktrees: mawjs-oracle.wt-7-codex →
    // mawjs-codex. This covers orphan panes whose title diverges from the
    // requested oracle-ish handle (#1502) while staying deterministic.
    const repoStem = repo?.replace(/-oracle$/, "");
    if (repoStem && repoStem !== repo) out.push({ name: `${repoStem}-${role}`, source: "worktree-alias" });
  }

  return out;
}

export function paneTargetCandidatesFromListPanesOutput(raw: string): PaneTargetCandidate[] {
  const candidates: PaneTargetCandidate[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [id = "", target = "", title = "", tileRole = "", cwd = ""] = line.split("|||");
    const resolved = id.trim() || target.trim();
    if (!resolved) continue;
    const paneTarget = target.trim();
    const add = (name: string, source: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      candidates.push({ name: trimmed, resolved, source, target: paneTarget });
    };
    add(title, "pane-title");
    add(tileRole, "tile-role");
    for (const wt of worktreeNamesFromCwd(cwd)) add(wt.name, wt.source);
  }
  return candidates;
}

function uniqueByResolved(candidates: PaneTargetCandidate[]): PaneTargetCandidate[] {
  const seen = new Set<string>();
  const out: PaneTargetCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.resolved)) continue;
    seen.add(candidate.resolved);
    out.push(candidate);
  }
  return out;
}

export function resolvePaneTargetFromCandidates(target: string, candidates: readonly PaneTargetCandidate[]): PaneTargetResolution {
  const exact = uniqueByResolved(candidates.filter(c => c.name.toLowerCase() === target.trim().toLowerCase()));
  if (exact.length === 1) return { kind: "match", candidate: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  const byName = resolveByName(target, candidates);
  if (byName.kind === "exact" || byName.kind === "fuzzy") return { kind: "match", candidate: byName.match };
  if (byName.kind === "ambiguous") return { kind: "ambiguous", candidates: uniqueByResolved(byName.candidates) };
  return { kind: "none" };
}

export function resolvePaneTargetFromListPanesOutput(target: string, raw: string): PaneTargetResolution {
  return resolvePaneTargetFromCandidates(target, paneTargetCandidatesFromListPanesOutput(raw));
}
