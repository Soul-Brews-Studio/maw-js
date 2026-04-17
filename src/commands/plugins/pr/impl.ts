import { Tmux } from "../../../core/transport/tmux";

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
    throw new Error("not in a tmux session — run inside tmux");
  }

  const t = new Tmux();

  // Get cwd of target window (or current pane)
  let cwd: string;
  if (window) {
    const session = (await t.run("display-message", "-p", "#{session_name}")).trim();
    cwd = (await t.run("display-message", "-t", `${session}:${window}`, "-p", "#{pane_current_path}")).trim();
  } else {
    cwd = (await t.run("display-message", "-p", "#{pane_current_path}")).trim();
  }

  if (!cwd) {
    throw new Error("could not detect working directory");
  }

  // Get current branch — use Bun.spawn arg-array to avoid cwd single-quote injection
  let branch: string;
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "branch", "--show-current"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    branch = (await new Response(proc.stdout).text()).trim();
  } catch {
    throw new Error(`not a git repo: ${cwd}`);
  }
  if (!branch) {
    throw new Error("detached HEAD — cannot create PR");
  }

  const title = branchToTitle(branch);
  const issueNum = extractIssueNum(branch);

  console.log(`\x1b[36m⚡\x1b[0m creating PR: "${title}" (${branch})`);
  if (issueNum) console.log(`\x1b[36m⚡\x1b[0m linking to issue #${issueNum}`);

  const body = issueNum ? `Closes #${issueNum}` : "";

  // Use Bun.spawn arg-array with cwd option — eliminates cd + shell-quoting workarounds
  try {
    const ghArgs = ["pr", "create", "--title", title];
    if (body) ghArgs.push("--body", body);
    else ghArgs.push("--body", "");
    const ghProc = Bun.spawn(["gh", ...ghArgs], { stdout: "pipe", stderr: "pipe", cwd });
    const [out, , code] = await Promise.all([
      new Response(ghProc.stdout).text(),
      new Response(ghProc.stderr).text(),
      ghProc.exited,
    ]);
    if (code !== 0) throw new Error(`gh pr create failed (exit ${code})`);
    const result = out.trim();
    console.log(`\x1b[32m✅\x1b[0m ${result}`);
  } catch (e: any) {
    throw new Error(e.message);
  }
}
