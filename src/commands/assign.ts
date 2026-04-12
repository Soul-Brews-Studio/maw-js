import { hostExec } from "../ssh";
import { cmdWake, fetchIssuePrompt } from "./wake";

function parseIssueUrl(url: string): { org: string; repo: string; issueNum: number } {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!m) throw new Error(`Invalid issue URL: ${url}\nExpected: https://github.com/org/repo/issues/N`);
  return { org: m[1], repo: m[2], issueNum: parseInt(m[3]) };
}

async function detectCurrentOracle(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  try {
    const windowName = (await hostExec("tmux display-message -p '#{window_name}'")).trim();
    // Window name pattern: <oracle>-oracle or <oracle>-<task>
    const m = windowName.match(/^([^-]+)-/);
    return m ? m[1] : null;
  } catch { return null; }
}

export async function cmdAssign(issueUrl: string, opts: { oracle?: string }): Promise<void> {
  const { org, repo, issueNum } = parseIssueUrl(issueUrl);
  const slug = `${org}/${repo}`;

  // Detect oracle from current window if not specified
  let oracle = opts.oracle;
  if (!oracle) {
    oracle = await detectCurrentOracle() ?? undefined;
  }
  if (!oracle) {
    console.error("could not detect oracle — pass --oracle <name>");
    process.exit(1);
  }

  console.log(`\x1b[36m⚡\x1b[0m fetching issue #${issueNum} from ${slug}...`);
  const prompt = await fetchIssuePrompt(issueNum, slug);

  await cmdWake(oracle, {
    incubate: slug,
    task: `issue-${issueNum}`,
    prompt,
  });
}
