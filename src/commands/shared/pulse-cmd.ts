import { hostExec } from "../../sdk";
import { cmdWake } from "./wake";
import {
  timePeriod, todayDate, todayLabel,
  findOrCreateDailyThread, addTaskToPeriodComment,
} from "./pulse-thread";

export async function cmdPulseAdd(title: string, opts: { oracle?: string; priority?: string; wt?: string }) {
  const repo = "laris-co/pulse-oracle";
  const projectNum = 6; // Master Board
  const period = timePeriod();

  // 0. Find or create daily thread
  const thread = await findOrCreateDailyThread(repo);

  // 1. Create task issue
  const escaped = title.replace(/'/g, "'\\''");
  const labels: string[] = [];
  if (opts.oracle) labels.push(`oracle:${opts.oracle}`);
  const labelFlags = labels.length ? labels.map(l => `-l '${l}'`).join(" ") : "";

  const issueUrl = (await hostExec(
    `gh issue create --repo ${repo} -t '${escaped}' ${labelFlags} -b 'Parent: #${thread.num}'`
  )).trim();
  const m = issueUrl.match(/\/(\d+)$/);
  const issueNum = m ? +m[1] : 0;
  console.log(`\x1b[32m+\x1b[0m issue #${issueNum} (${period}): ${issueUrl}`);

  // 2. Add task to period comment in daily thread (edit triggers webhook!)
  await addTaskToPeriodComment(repo, thread.num, period, issueNum, title, opts.oracle);
  console.log(`\x1b[32m+\x1b[0m added to ${period} in daily thread #${thread.num}`);

  // 3. Add to Master Board
  try {
    await hostExec(`gh project item-add ${projectNum} --owner laris-co --url '${issueUrl}'`);
    console.log(`\x1b[32m+\x1b[0m added to Master Board (#${projectNum})`);
  } catch (e) {
    console.log(`\x1b[33mwarn:\x1b[0m could not add to project board: ${e}`);
  }

  // 4. Wake oracle if specified
  if (opts.oracle) {
    const wakeOpts: { task?: string; newWt?: string; prompt?: string } = {};
    if (opts.wt) {
      wakeOpts.newWt = opts.wt;
    }
    const prompt = `/recap --deep — You have been assigned issue #${issueNum}: ${title}. Issue URL: ${issueUrl}. Orient yourself, then wait for human instructions.`;
    wakeOpts.prompt = prompt;

    const target = await cmdWake(opts.oracle, wakeOpts);
    console.log(`\x1b[32m🚀\x1b[0m ${target}: waking up with /recap --deep → then --continue`);
  }
}

export async function cmdPulseLs(opts: { sync?: boolean }) {
  const repo = "laris-co/pulse-oracle";

  // Fetch all open issues
  const issuesJson = (await hostExec(
    `gh issue list --repo ${repo} --state open --json number,title,labels --limit 50`
  )).trim();
  const issues: { number: number; title: string; labels: { name: string }[] }[] = JSON.parse(issuesJson || "[]");

  // Categorize
  const projects: typeof issues = [];
  const today: typeof issues = [];
  const threads: typeof issues = [];

  for (const issue of issues) {
    const labels = issue.labels.map(l => l.name);
    if (labels.includes("daily-thread")) { threads.push(issue); continue; }
    if (/^P\d{3}/.test(issue.title)) { projects.push(issue); continue; }
    today.push(issue);
  }

  // Separate tools from today's active
  const toolIssues: typeof issues = [];
  const activeIssues: typeof issues = [];
  for (const issue of today) {
    const isToday = issue.title.includes("Daily") || issue.number > (threads[0]?.number || 0);
    if (isToday && !issue.title.includes("Daily")) activeIssues.push(issue);
    else toolIssues.push(issue);
  }

  const getOracle = (issue: typeof issues[0]) => {
    const label = issue.labels.find(l => l.name.startsWith("oracle:"));
    return label ? label.name.replace("oracle:", "") : "—";
  };

  // Terminal table
  console.log(`\n\x1b[36m📋 Pulse Board\x1b[0m\n`);

  if (projects.length) {
    console.log(`\x1b[33mProjects (${projects.length})\x1b[0m`);
    console.log(`┌──────┬${"─".repeat(50)}┬──────────────┐`);
    for (const p of projects.sort((a, b) => a.number - b.number)) {
      const oracle = getOracle(p);
      console.log(`│ \x1b[32m#${String(p.number).padEnd(3)}\x1b[0m │ ${p.title.slice(0, 48).padEnd(48)} │ ${oracle.padEnd(12)} │`);
    }
    console.log(`└──────┴${"─".repeat(50)}┴──────────────┘`);
  }

  if (toolIssues.length) {
    console.log(`\n\x1b[33mTools/Infra (${toolIssues.length})\x1b[0m`);
    console.log(`┌──────┬${"─".repeat(50)}┬──────────────┐`);
    for (const t of toolIssues.sort((a, b) => a.number - b.number)) {
      const oracle = getOracle(t);
      console.log(`│ \x1b[32m#${String(t.number).padEnd(3)}\x1b[0m │ ${t.title.slice(0, 48).padEnd(48)} │ ${oracle.padEnd(12)} │`);
    }
    console.log(`└──────┴${"─".repeat(50)}┴──────────────┘`);
  }

  if (activeIssues.length) {
    console.log(`\n\x1b[33mActive Today (${activeIssues.length})\x1b[0m`);
    for (const a of activeIssues.sort((a2, b) => a2.number - b.number)) {
      const oracle = getOracle(a);
      console.log(`  \x1b[33m🟡\x1b[0m #${a.number} ${a.title} → ${oracle}`);
    }
  }

  console.log(`\n\x1b[36m${issues.length - threads.length} open\x1b[0m\n`);

  // --sync: update daily thread with checkboxes
  if (opts.sync) {
    const thread = threads.find(t => t.title.includes(todayDate()));
    if (!thread) { console.log("No daily thread found for today"); return; }

    const lines: string[] = [`## 📋 Pulse Board Index (${todayLabel()})`, ""];

    if (projects.length) {
      lines.push(`### Projects (${projects.length})`, "");
      for (const p of projects.sort((a, b) => a.number - b.number)) {
        lines.push(`- [ ] #${p.number} ${p.title} → ${getOracle(p)}`);
      }
      lines.push("");
    }
    if (toolIssues.length) {
      lines.push(`### Tools/Infra (${toolIssues.length})`, "");
      for (const t of toolIssues.sort((a, b) => a.number - b.number)) {
        lines.push(`- [ ] #${t.number} ${t.title} → ${getOracle(t)}`);
      }
      lines.push("");
    }
    if (activeIssues.length) {
      lines.push(`### Active Today (${activeIssues.length})`, "");
      for (const a of activeIssues.sort((a2, b) => a2.number - b.number)) {
        lines.push(`- [ ] #${a.number} ${a.title} → ${getOracle(a)} 🟡`);
      }
      lines.push("");
    }
    lines.push(`**${issues.length - threads.length} open** — Homekeeper Oracle 🤖`);

    const body = lines.join("\n").replace(/'/g, "'\\''");

    // Find or create index comment
    const commentsJson2 = (await hostExec(
      `gh api repos/${repo}/issues/${thread.number}/comments --jq '[.[] | {id: .id, body: .body}]'`
    )).trim();
    const comments: { id: string; body: string }[] = JSON.parse(commentsJson2 || "[]");
    const indexComment = comments.find(c => c.body.includes("Pulse Board Index"));

    if (indexComment) {
      await hostExec(`gh api repos/${repo}/issues/comments/${indexComment.id} -X PATCH -f body='${body}'`);
      console.log(`\x1b[32m✅\x1b[0m synced to daily thread #${thread.number}`);
    } else {
      await hostExec(`gh api repos/${repo}/issues/${thread.number}/comments -f body='${body}'`);
      console.log(`\x1b[32m+\x1b[0m index posted to daily thread #${thread.number}`);
    }
  }
}
