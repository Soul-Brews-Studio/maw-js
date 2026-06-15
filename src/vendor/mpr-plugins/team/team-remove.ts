// Single-verb member removal (#2073). Tears down the member's pane/worktree
// (reusing `maw done` logic) AND drops the member from the charter YAML
// atomically, so the charter never drifts from lived state.
import { readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { loadConfig } from "../../../config/load";
import type { MawConfig } from "../../../config/types";
import { cmdDone } from "../../../commands/shared/done";
import { Tmux } from "../../../core/transport/tmux";
import { readTeamCharter, type TeamCharterMember } from "./team-charter";
import {
  classifyMember,
  currentTmuxSession,
  listPaneSnapshots,
  memberMatchesSelector,
  memberWindowIdentity,
  resolveCharterPath,
  type ClassifiedTeamMember,
} from "./team-liveness";

type RemoveDone = (windowName: string, opts?: { sessionName?: string; keepBranch?: boolean }) => Promise<void>;

export interface TeamRemoveOptions {
  keepBranch?: boolean;
  dryRun?: boolean;
}

export interface TeamRemoveDeps {
  tmux?: Pick<Tmux, "run">;
  cwd?: string;
  charterPath?: string | null;
  readTeamCharterFn?: typeof readTeamCharter;
  loadConfigFn?: typeof loadConfig;
  cmdDoneFn?: RemoveDone;
  writeFileFn?: typeof writeFileSync;
  renameFn?: typeof renameSync;
  logger?: (line: string) => void;
}

export interface TeamRemoveAction {
  phase: "teardown" | "charter";
  detail: string;
}

export interface TeamRemoveResult {
  team: string;
  session: string;
  member: string;
  target: string;
  state: string;
  charterPath: string;
  actions: TeamRemoveAction[];
  output: string;
}

/** Extract the role/name/worktree of a single `members:` list block for matching. */
function parseMemberBlock(blockLines: string[]): TeamCharterMember | null {
  const fields: Record<string, string> = {};
  for (const raw of blockLines) {
    const line = raw.replace(/^\s*-\s*/, "").trim();
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) fields[m[1]!] = (m[2] ?? "").trim();
  }
  const role = fields.role;
  if (!role) return null;
  const member: TeamCharterMember = { role };
  if (fields.name) member.name = unquote(fields.name);
  if (fields.worktree !== undefined && fields.worktree !== "") {
    member.worktree = fields.worktree === "false" ? false : fields.worktree === "true" ? true : unquote(fields.worktree);
  }
  return member;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function indentOf(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

interface MemberBlock {
  start: number;
  end: number; // exclusive
  member: TeamCharterMember;
}

/** Locate the `members:` list blocks in raw charter text, line-indexed for removal. */
function locateMemberBlocks(lines: string[]): MemberBlock[] {
  const membersIdx = lines.findIndex((l) => /^members:\s*$/.test(l));
  if (membersIdx === -1) return [];

  const blocks: MemberBlock[] = [];
  let i = membersIdx + 1;
  let dashIndent = -1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const indent = indentOf(line);
    if (indent === 0) break; // back to top-level keys

    const isDash = /^\s*-\s/.test(line);
    if (dashIndent === -1 && isDash) dashIndent = indent;
    if (!isDash || indent !== dashIndent) { i++; continue; }

    const start = i;
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() && indentOf(next) <= dashIndent) break;
      i++;
    }
    // Trim trailing blank lines back out of the block.
    let end = i;
    while (end > start + 1 && !lines[end - 1]!.trim()) end--;
    const member = parseMemberBlock(lines.slice(start, end));
    if (member) blocks.push({ start, end, member });
  }
  return blocks;
}

/** Remove one member from charter YAML text by line range. Throws if not exactly one match. */
export function removeMemberFromCharterText(text: string, selector: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (trailingNewline) lines.pop();

  const blocks = locateMemberBlocks(lines);
  const matches = blocks.filter((b) => memberMatchesSelector(b.member, selector));
  if (matches.length === 0) throw new Error(`member not found in charter: ${selector}`);
  if (matches.length > 1) {
    throw new Error(`member '${selector}' is ambiguous in charter (${matches.length} matches)`);
  }
  if (blocks.length === 1) {
    throw new Error(`refusing to remove the last member '${selector}'; a team charter requires at least one member`);
  }

  const { start, end } = matches[0]!;
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  return kept.join(eol) + (trailingNewline ? eol : "");
}

function atomicWrite(
  path: string,
  content: string,
  writeFn: typeof writeFileSync,
  renameFn: typeof renameSync,
): void {
  const tmp = join(dirname(path), `.${Date.now()}.team-remove.tmp`);
  writeFn(tmp, content, "utf-8");
  renameFn(tmp, path);
}

export async function cmdTeamRemove(
  team: string,
  selector: string,
  opts: TeamRemoveOptions = {},
  deps: TeamRemoveDeps = {},
): Promise<TeamRemoveResult> {
  const cwd = deps.cwd ?? process.cwd();
  const charterPath = deps.charterPath !== undefined ? deps.charterPath : resolveCharterPath(team, cwd);
  if (!charterPath) throw new Error(`team not found: ${team}`);

  const read = deps.readTeamCharterFn ?? readTeamCharter;
  const charter = read(charterPath);
  const config: MawConfig = (deps.loadConfigFn ?? loadConfig)();
  const tmux = deps.tmux ?? new Tmux();
  const session = charter.session ?? (await currentTmuxSession(tmux).catch(() => ""));
  const panes = await listPaneSnapshots(tmux);

  const classified: ClassifiedTeamMember[] = charter.members
    .map((member) => classifyMember(member, panes, session, { currentNode: config.node }))
    .filter((item) => memberMatchesSelector(item.member, selector));
  if (classified.length === 0) throw new Error(`member not found: ${selector}`);
  if (classified.length > 1) {
    throw new Error(`member '${selector}' is ambiguous across: ${classified.map((c) => c.role).join(", ")}`);
  }

  const selected = classified[0]!;
  const target = selected.pane?.windowName ?? memberWindowIdentity(selected.member);
  const hasWorktree = selected.member.worktree !== false;
  const actions: TeamRemoveAction[] = [];

  // Compute (and validate) the charter edit up front so a malformed charter
  // aborts before we tear down a worktree — keeping the two steps consistent.
  const original = readFileSync(charterPath, "utf-8");
  const updated = removeMemberFromCharterText(original, selector);

  if (!hasWorktree) {
    actions.push({ phase: "teardown", detail: `no worktree for ${target} (worktree: false)` });
  } else if (opts.dryRun) {
    const branchNote = opts.keepBranch ? " (keep branch)" : "";
    actions.push({ phase: "teardown", detail: `would maw done ${target}${branchNote}` });
  } else {
    const done = deps.cmdDoneFn ?? cmdDone;
    await done(target, { sessionName: session, keepBranch: opts.keepBranch });
    actions.push({ phase: "teardown", detail: `maw done ${target}${opts.keepBranch ? " (kept branch)" : ""}` });
  }

  if (opts.dryRun) {
    actions.push({ phase: "charter", detail: `would remove '${selected.role}' from ${charterPath}` });
  } else {
    atomicWrite(charterPath, updated, deps.writeFileFn ?? writeFileSync, deps.renameFn ?? renameSync);
    actions.push({ phase: "charter", detail: `removed '${selected.role}' from ${charterPath}` });
  }

  const lines = [
    `team remove: ${team}`,
    `member\t${selected.role}`,
    `target\t${target}`,
    `state\t${selected.state}`,
    `action\t${opts.dryRun ? "dry-run" : "teardown+charter-edit"}`,
    `session\t${session || "(none)"}`,
    "",
    ...actions.map((a) => `  ${a.phase}: ${a.detail}`),
    opts.dryRun ? "\nNo changes made" : "",
  ].filter((line) => line !== undefined);
  const output = lines.join("\n");
  (deps.logger ?? ((l: string) => console.log(l)))(output);

  return {
    team,
    session,
    member: selected.role,
    target,
    state: selected.state,
    charterPath,
    actions,
    output,
  };
}
