import { hostExec } from "../../sdk";

const THAI_DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayLabel(): string {
  const d = new Date();
  const date = todayDate();
  const day = THAI_DAYS[d.getDay()];
  return `${date} (${day})`;
}

export function timePeriod(): string {
  const h = new Date().getHours();
  if (h >= 6 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  if (h >= 18) return "evening";
  return "midnight";
}

const PERIODS = [
  { key: "morning", label: "🌅 Morning (06:00-12:00)", hours: [6, 12] },
  { key: "afternoon", label: "☀️ Afternoon (12:00-18:00)", hours: [12, 18] },
  { key: "evening", label: "🌆 Evening (18:00-24:00)", hours: [18, 24] },
  { key: "midnight", label: "🌙 Midnight (00:00-06:00)", hours: [0, 6] },
] as const;

export async function findOrCreateDailyThread(repo: string): Promise<{ url: string; num: number; isNew: boolean }> {
  const date = todayDate();
  const label = todayLabel();
  const searchDate = `📅 ${date}`;
  const threadTitle = `📅 ${label} Daily Thread`;

  // Search for existing daily thread (match by date only)
  const existing = (await hostExec(
    `gh issue list --repo ${repo} --search '${searchDate} in:title' --state open --json number,url,title --limit 1`
  )).trim();
  const parsed = JSON.parse(existing || "[]");
  if (parsed.length > 0 && parsed[0].title.includes(date)) {
    return { url: parsed[0].url, num: parsed[0].number, isNew: false };
  }

  // Create new daily thread with Thai day name
  const url = (await hostExec(
    `gh issue create --repo ${repo} -t '${threadTitle.replace(/'/g, "'\\''")}' -b 'Tasks for ${label}' -l daily-thread`
  )).trim();
  const m = url.match(/\/(\d+)$/);
  const num = m ? +m[1] : 0;
  console.log(`\x1b[32m+\x1b[0m daily thread #${num}: ${url}`);
  return { url, num, isNew: true };
}

async function ensurePeriodComments(repo: string, threadNum: number): Promise<Record<string, { id: string; body: string }>> {
  // Fetch existing comments
  const commentsJson = (await hostExec(
    `gh api repos/${repo}/issues/${threadNum}/comments --jq '[.[] | {id: .id, body: .body}]'`
  )).trim();
  const comments: { id: string; body: string }[] = JSON.parse(commentsJson || "[]");

  const result: Record<string, { id: string; body: string }> = {};

  for (const p of PERIODS) {
    const existing = comments.find(c => c.body.startsWith(p.label));
    if (existing) {
      result[p.key] = existing;
    } else {
      // Create period comment
      const body = `${p.label}\n\n_(no tasks yet)_`;
      const escaped = body.replace(/'/g, "'\\''");
      const created = (await hostExec(
        `gh api repos/${repo}/issues/${threadNum}/comments -f body='${escaped}' --jq '.id'`
      )).trim();
      result[p.key] = { id: created, body };
    }
  }

  return result;
}

export async function addTaskToPeriodComment(repo: string, threadNum: number, period: string, issueNum: number, title: string, oracle?: string) {
  const periodComments = await ensurePeriodComments(repo, threadNum);
  const comment = periodComments[period];
  if (!comment) return;

  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const oracleTag = oracle ? ` → ${oracle}` : "";
  const taskLine = `- [ ] #${issueNum} ${title} (${now}${oracleTag})`;

  // Replace "no tasks yet" or append
  let newBody: string;
  if (comment.body.includes("_(no tasks yet)_")) {
    newBody = comment.body.replace("_(no tasks yet)_", taskLine);
  } else {
    newBody = comment.body + "\n" + taskLine;
  }

  const escaped = newBody.replace(/'/g, "'\\''");
  await hostExec(`gh api repos/${repo}/issues/comments/${comment.id} -X PATCH -f body='${escaped}'`);
}
