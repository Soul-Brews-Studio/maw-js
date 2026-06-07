import type { Session, Window } from "../runtime/find-window";
import { resolveWorktreeTarget } from "../matcher/resolve-target";

export type WorktreeWindowResolution =
  | { kind: "bound"; window: string }
  | { kind: "ambiguous"; query: string; candidates: string[] }
  | { kind: "none" };

function dedupeWindowsByName(sessions: Session[]): Window[] {
  return [...new Map(sessions.flatMap(s => s.windows).map(w => [w.name, w])).values()];
}

function parentOracleNameFromMainRepo(mainRepoName: string): string {
  return mainRepoName.replace(/-oracle$/, "");
}

function parentSessionsFor(mainRepoName: string, sessions: Session[]): Session[] {
  const parentOracleName = parentOracleNameFromMainRepo(mainRepoName);
  return sessions.filter(s =>
    s.name === parentOracleName || s.name.endsWith(`-${parentOracleName}`)
  );
}

function boundWindow(
  target: string,
  windows: Window[],
): string | null {
  const resolved = resolveWorktreeTarget(target, windows);
  if (resolved.kind === "exact" || resolved.kind === "fuzzy") {
    return resolved.match.name;
  }
  return null;
}

/**
 * Pure worktree-to-window matching policy used by scanWorktrees().
 *
 * Matching order preserves the production invariants fixed by #823/#935/#1553:
 * 1. dedupe same-named windows across sessions,
 * 2. try parent oracle sessions before global search,
 * 3. try the full worktree name before stripping its numeric prefix,
 * 4. fail with explicit ambiguity instead of binding a guessed window.
 */
export function resolveWorktreeWindow(
  mainRepoName: string,
  wtName: string,
  sessions: Session[],
): WorktreeWindowResolution {
  const taskPart = wtName.replace(/^\d+-/, "");
  const parentSessions = parentSessionsFor(mainRepoName, sessions);

  if (parentSessions.length > 0) {
    const scopedWindows = dedupeWindowsByName(parentSessions);
    const fullScoped = boundWindow(wtName, scopedWindows);
    if (fullScoped) return { kind: "bound", window: fullScoped };

    const taskScoped = boundWindow(taskPart, scopedWindows);
    if (taskScoped) return { kind: "bound", window: taskScoped };
  }

  const allWindows = dedupeWindowsByName(sessions);
  const fullGlobal = boundWindow(wtName, allWindows);
  if (fullGlobal) return { kind: "bound", window: fullGlobal };

  const taskResolved = resolveWorktreeTarget(taskPart, allWindows);
  if (taskResolved.kind === "exact" || taskResolved.kind === "fuzzy") {
    return { kind: "bound", window: taskResolved.match.name };
  }
  if (taskResolved.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      query: taskPart,
      candidates: taskResolved.candidates.map(candidate => candidate.name),
    };
  }
  return { kind: "none" };
}
