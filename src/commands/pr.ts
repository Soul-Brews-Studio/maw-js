import { hostExec } from "../ssh";

function branchToTitle(branch: string): string {
  // Strip prefix like "agents/" or "feature/"
  const stripped = branch.replace(/^[^/]+\//, "");
  // Convert hyphens/underscores to spaces, title-case
  return stripped
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function extractIssueNum(branch: string): number | null {
  const m = branch.match(/issue-(\d+)/i);
  return m ? parseInt(m[1]) : null;
}

export async function cmdPr(window?: string): Promise<void> {
  if (!process.env.TMUX) {
    console.error("not in a tmux session — run inside tmux");
    process.exit(1);
  }

  // Get cwd of target window (or current pane)
  let cwd: string;
  if (window) {
    const session = (await hostExec("tmux display-message -p '#{session_name}'")).trim();
    cwd = (await hostExec(`tmux display-message -t '${session}:${window}' -p '#{pane_current_path}'`)).trim();
  } else {
    cwd = (await hostExec("tmux display-message -p '#{pane_current_path}'")).trim();
  }

  if (!cwd) {
    console.error("could not detect working directory");
    process.exit(1);
  }

  // Get current branch
  let branch: string;
  try {
    branch = (await hostExec(`git -C '${cwd}' branch --show-current`)).trim();
  } catch {
    console.error(`not a git repo: ${cwd}`);
    process.exit(1);
  }
  if (!branch) {
    console.error("detached HEAD — cannot create PR");
    process.exit(1);
  }

  const title = branchToTitle(branch);
  const issueNum = extractIssueNum(branch);

  console.log(`\x1b[36m⚡\x1b[0m creating PR: "${title}" (${branch})`);
  if (issueNum) console.log(`\x1b[36m⚡\x1b[0m linking to issue #${issueNum}`);

  const body = issueNum ? `Closes #${issueNum}` : "";
  const bodyFlag = body ? `--body '${body}'` : "--body ''";
  const titleEscaped = title.replace(/'/g, "'\\''");

  try {
    const result = await hostExec(`cd '${cwd}' && gh pr create --title '${titleEscaped}' ${bodyFlag}`);
    console.log(`\x1b[32m✅\x1b[0m ${result}`);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
    process.exit(1);
  }
}
