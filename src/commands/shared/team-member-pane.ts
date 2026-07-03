import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * kobo-81 — resolve a bare name to a live maw-team member's bound tmux pane id.
 *
 * A worker spawned by `maw team spawn --exec` binds its `%pane-id` into the team
 * roster (`~/.claude/teams/<team>/config.json`, field `tmuxPaneId`). Team workers
 * are NOT federation oracles — they have no repo, so `maw hey`'s repo→window
 * locate path can't find them and the send silently failed ("bare = local-only
 * fail"). This scans the tool-store team configs for a member of this name that
 * carries a non-sentinel pane id and returns it, so the bare-name resolver can
 * deliver to the real pane.
 *
 * Kept in its own module (not folded into comm-send) so comm-send needs no new
 * fs/path/os import — that barrel is widely mock.module'd and a top-level import
 * there breaks inline partial mocks at link time. Callers dynamic-import this.
 *
 * `teamsDir` and `livePanes` are injectable for tests. When `livePanes` is
 * given, a binding whose pane is no longer live is skipped (stale-guard); by
 * default no tmux call is made (tmux never reuses a `%id`, so a dead binding
 * simply fails delivery cleanly rather than misrouting).
 */
export function resolveTeamMemberPane(
  name: string,
  deps: { teamsDir?: string; livePanes?: Set<string> } = {},
): string | null {
  if (!name) return null;
  const teamsDir = deps.teamsDir ?? join(homedir(), ".claude", "teams");
  let entries: string[];
  try {
    entries = readdirSync(teamsDir);
  } catch {
    return null; // no teams dir → nothing to resolve
  }
  for (const team of entries) {
    const cfgPath = join(teamsDir, team, "config.json");
    if (!existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      const member = (cfg.members ?? []).find(
        (m: any) =>
          (m?.name === name || m?.agentId === name) &&
          typeof m?.tmuxPaneId === "string" &&
          m.tmuxPaneId !== "" &&
          m.tmuxPaneId !== "in-process",
      );
      if (!member) continue;
      if (deps.livePanes && !deps.livePanes.has(member.tmuxPaneId)) continue; // stale binding
      return member.tmuxPaneId as string;
    } catch {
      /* skip a malformed / half-written config */
    }
  }
  return null;
}
