#!/usr/bin/env bun
process.env.MAW_CLI = "1";

import { listSessions, findWindow, capture, sendKeys, ssh } from "./ssh";

const args = process.argv.slice(2);
const cmd = args[0]?.toLowerCase();

async function cmdList() {
  const sessions = await listSessions();
  for (const s of sessions) {
    console.log(`\x1b[36m${s.name}\x1b[0m`);
    for (const w of s.windows) {
      const dot = w.active ? "\x1b[32m*\x1b[0m" : " ";
      console.log(`  ${dot} ${w.index}: ${w.name}`);
    }
  }
}

async function cmdPeek(query?: string) {
  const sessions = await listSessions();
  if (!query) {
    // Peek all — one line per agent
    for (const s of sessions) {
      for (const w of s.windows) {
        const target = `${s.name}:${w.index}`;
        try {
          const content = await capture(target, 3);
          const lastLine = content.split("\n").filter(l => l.trim()).pop() || "(empty)";
          const dot = w.active ? "\x1b[32m*\x1b[0m" : " ";
          console.log(`${dot} \x1b[36m${w.name.padEnd(22)}\x1b[0m ${lastLine.slice(0, 80)}`);
        } catch {
          console.log(`  \x1b[36m${w.name.padEnd(22)}\x1b[0m (unreachable)`);
        }
      }
    }
    return;
  }
  const target = findWindow(sessions, query);
  if (!target) { console.error(`window not found: ${query}`); process.exit(1); }
  const content = await capture(target);
  console.log(`\x1b[36m--- ${target} ---\x1b[0m`);
  console.log(content);
}

async function cmdSend(query: string, message: string) {
  const sessions = await listSessions();
  const target = findWindow(sessions, query);
  if (!target) { console.error(`window not found: ${query}`); process.exit(1); }
  await sendKeys(target, message);
  console.log(`\x1b[32msent\x1b[0m → ${target}: ${message}`);
}

// --- Shared helpers ---

async function resolveOracle(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  const ghqOut = await ssh(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`);
  if (!ghqOut) {
    console.error(`oracle repo not found: ${oracle}-oracle`);
    process.exit(1);
  }
  const repoPath = ghqOut.trim();
  const repoName = repoPath.split("/").pop()!;
  const parentDir = repoPath.replace(/\/[^/]+$/, "");
  return { repoPath, repoName, parentDir };
}

async function findWorktrees(parentDir: string, repoName: string): Promise<{ path: string; name: string }[]> {
  const lsOut = await ssh(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
  return lsOut.split("\n").filter(Boolean).map(p => {
    const base = p.split("/").pop()!;
    const suffix = base.replace(`${repoName}.wt-`, "");
    return { path: p, name: suffix };
  });
}

// Oracle → tmux session mapping
const SESSION_MAP: Record<string, string> = {
  neo: "8-neo",
  hermes: "7-hermes",
  pulse: "9-pulse",
  calliope: "10-calliope",
};

async function detectSession(oracle: string): Promise<string | null> {
  const sessions = await listSessions();
  const mapped = SESSION_MAP[oracle];
  if (mapped) {
    const exists = sessions.find(s => s.name === mapped);
    if (exists) return mapped;
  }
  return sessions.find(s => /^\d+-/.test(s.name) && s.name.endsWith(`-${oracle}`))?.name
    || sessions.find(s => s.name === oracle)?.name
    || null;
}

// --- Commands ---

async function cmdWake(oracle: string, opts: { task?: string; newWt?: string; prompt?: string }): Promise<string> {
  const { repoPath, repoName, parentDir } = await resolveOracle(oracle);

  // Detect or create tmux session
  let session = await detectSession(oracle);
  if (!session) {
    session = SESSION_MAP[oracle] || oracle;
    await ssh(`tmux new-session -d -s '${session}' -n '${oracle}' -c '${repoPath}'`);
    console.log(`\x1b[32m+\x1b[0m created session '${session}'`);
  }

  let targetPath = repoPath;
  let windowName = oracle;

  if (opts.newWt || opts.task) {
    const name = opts.newWt || opts.task!;
    const worktrees = await findWorktrees(parentDir, repoName);

    // Try to find existing worktree matching this name
    const match = worktrees.find(w => w.name.endsWith(`-${name}`) || w.name === name);

    if (match) {
      // Reuse existing worktree
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      // Create new worktree
      const nums = worktrees.map(w => parseInt(w.name) || 0);
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const wtName = `${nextNum}-${name}`;
      const wtPath = `${parentDir}/${repoName}.wt-${wtName}`;
      const branch = `agents/${wtName}`;

      await ssh(`git -C '${repoPath}' worktree add '${wtPath}' -b '${branch}'`);
      console.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch})`);

      targetPath = wtPath;
      windowName = `${oracle}-${name}`;
    }
  }

  // Check if window already exists
  try {
    const winList = await ssh(`tmux list-windows -t '${session}' -F '#{window_name}' 2>/dev/null`);
    if (winList.split("\n").some(w => w === windowName)) {
      if (opts.prompt) {
        // Window exists but we have a prompt → send claude -p
        console.log(`\x1b[33m⚡\x1b[0m '${windowName}' exists, sending prompt`);
        await ssh(`tmux select-window -t '${session}:${windowName}'`);
        const escaped = opts.prompt.replace(/'/g, "'\\''");
        await ssh(`tmux send-keys -t '${session}:${windowName}' "claude -p '${escaped}' --dangerously-skip-permissions && claude --continue --dangerously-skip-permissions" Enter`);
        return `${session}:${windowName}`;
      }
      console.log(`\x1b[33m⚡\x1b[0m '${windowName}' already running in ${session}`);
      await ssh(`tmux select-window -t '${session}:${windowName}'`);
      return `${session}:${windowName}`;
    }
  } catch { /* session might be fresh */ }

  // Create window + start claude (or claude -p with prompt)
  await ssh(`tmux new-window -t '${session}' -n '${windowName}' -c '${targetPath}'`);
  await new Promise(r => setTimeout(r, 300));
  if (opts.prompt) {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    await ssh(`tmux send-keys -t '${session}:${windowName}' "claude -p '${escaped}' --dangerously-skip-permissions && claude --continue --dangerously-skip-permissions" Enter`);
  } else {
    await ssh(`tmux send-keys -t '${session}:${windowName}' 'claude' Enter`);
  }

  console.log(`\x1b[32m✅\x1b[0m woke '${windowName}' in ${session} → ${targetPath}`);
  return `${session}:${windowName}`;
}

function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timePeriod(): string {
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

async function findOrCreateDailyThread(repo: string): Promise<{ url: string; num: number; isNew: boolean }> {
  const date = todayDate();
  const threadTitle = `📅 ${date} Daily Thread`;

  // Search for existing daily thread
  const existing = (await ssh(
    `gh issue list --repo ${repo} --search '${threadTitle} in:title' --state open --json number,url,title --limit 1`
  )).trim();
  const parsed = JSON.parse(existing || "[]");
  if (parsed.length > 0 && parsed[0].title === threadTitle) {
    return { url: parsed[0].url, num: parsed[0].number, isNew: false };
  }

  // Create new daily thread with body
  const url = (await ssh(
    `gh issue create --repo ${repo} -t '${threadTitle.replace(/'/g, "'\\''")}' -b 'Tasks for ${date}' -l daily-thread`
  )).trim();
  const m = url.match(/\/(\d+)$/);
  const num = m ? +m[1] : 0;
  console.log(`\x1b[32m+\x1b[0m daily thread #${num}: ${url}`);
  return { url, num, isNew: true };
}

async function ensurePeriodComments(repo: string, threadNum: number): Promise<Record<string, { id: string; body: string }>> {
  // Fetch existing comments
  const commentsJson = (await ssh(
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
      const jsonBody = JSON.stringify({ body });
      const escapedBody = jsonBody.replace(/'/g, "'\\''");
      const created = (await ssh(
        `echo '${escapedBody}' | gh api repos/${repo}/issues/${threadNum}/comments --input - --jq '.id'`
      )).trim();
      result[p.key] = { id: created, body };
    }
  }

  return result;
}

async function addTaskToPeriodComment(repo: string, threadNum: number, period: string, issueNum: number, title: string, oracle?: string) {
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

  // Use --input to pass body via stdin (handles newlines correctly)
  const jsonBody = JSON.stringify({ body: newBody });
  const escaped = jsonBody.replace(/'/g, "'\\''");
  await ssh(`echo '${escaped}' | gh api repos/${repo}/issues/comments/${comment.id} -X PATCH --input -`);
}

async function cmdPulseAdd(title: string, opts: { oracle?: string; priority?: string; wt?: string }) {
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

  const issueUrl = (await ssh(
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
    await ssh(`gh project item-add ${projectNum} --owner laris-co --url '${issueUrl}'`);
    console.log(`\x1b[32m+\x1b[0m added to Master Board (#${projectNum})`);
  } catch (e) {
    console.log(`\x1b[33mwarn:\x1b[0m could not add to project board: ${e}`);
  }

  // 3. Wake oracle if specified
  if (opts.oracle) {
    const wakeOpts: { task?: string; newWt?: string; prompt?: string } = {};
    if (opts.wt) {
      // --wt <name>: use existing or create new worktree with this name
      wakeOpts.newWt = opts.wt;
    }
    // First command: orient with /recap --deep, not implement
    const prompt = `/recap --deep — You have been assigned issue #${issueNum}: ${title}. Issue URL: ${issueUrl}. Orient yourself, then wait for human instructions.`;
    wakeOpts.prompt = prompt;

    const target = await cmdWake(opts.oracle, wakeOpts);
    console.log(`\x1b[32m🚀\x1b[0m ${target}: waking up with /recap --deep → then --continue`);
  }
}

async function cmdSpawn(oracle: string, opts: { name?: string; continue?: boolean }) {
  const { repoPath, repoName, parentDir } = await resolveOracle(oracle);

  const worktrees = await findWorktrees(parentDir, repoName);

  const sessionName = opts.name || `${oracle}`;

  // Check if session exists
  try {
    await ssh(`tmux has-session -t '${sessionName}' 2>/dev/null`);
    console.log(`\x1b[33msession already exists:\x1b[0m ${sessionName}`);
    console.log(`  attach: tmux attach -t ${sessionName}`);
    return;
  } catch { /* session doesn't exist — good */ }

  // Create session with main repo as first window
  await ssh(`tmux new-session -d -s '${sessionName}' -n '${oracle}' -c '${repoPath}'`);
  console.log(`\x1b[32m+\x1b[0m ${oracle} → ${repoPath}`);

  // Add worktree windows
  for (const wt of worktrees) {
    const winName = `${oracle}-${wt.name}`;
    await ssh(`tmux new-window -t '${sessionName}' -n '${winName}' -c '${wt.path}'`);
    console.log(`\x1b[32m+\x1b[0m ${winName} → ${wt.path}`);
  }

  // Optionally start claude --continue in all windows
  if (opts.continue) {
    const winList = await ssh(`tmux list-windows -t '${sessionName}' -F '#{window_index}'`);
    for (const idx of winList.split("\n").filter(Boolean)) {
      await ssh(`tmux send-keys -t '${sessionName}:${idx}' 'claude --continue' Enter`);
    }
    console.log(`\x1b[36mall waking with --continue\x1b[0m`);
  }

  await ssh(`tmux select-window -t '${sessionName}:1'`);
  console.log(`\n\x1b[36mspawned:\x1b[0m ${sessionName} (${1 + worktrees.length} windows)`);
  console.log(`  attach: tmux attach -t ${sessionName}`);
}

function usage() {
  console.log(`\x1b[36mmaw\x1b[0m — Multi-Agent Workflow

\x1b[33mUsage:\x1b[0m
  maw ls                      List sessions + windows
  maw peek [agent]            Peek agent screen (or all)
  maw hey <agent> <msg...>    Send message to agent (alias: tell)
  maw wake <oracle> [task]    Wake oracle in tmux window + claude
  maw spawn <oracle> [opts]   Create tmux session from worktrees
  maw pulse add "task" [opts] Create issue + wake oracle
  maw <agent> <msg...>        Shorthand for hey
  maw <agent>                 Shorthand for peek
  maw serve [port]            Start web UI (default: 3456)

\x1b[33mWake modes:\x1b[0m
  maw wake neo                Wake main repo
  maw wake hermes bitkub      Wake existing worktree
  maw wake neo --new free     Create worktree + wake

\x1b[33mPulse add:\x1b[0m
  maw pulse add "Fix bug" --oracle neo
  maw pulse add "Add status tool" --oracle neo --wt oracle-v2
  maw pulse add "Deploy" --oracle hermes --wt bitkub

\x1b[33mSpawn options:\x1b[0m
  --name <session>            Custom tmux session name
  --continue, -c              Auto-start claude --continue in all windows

\x1b[33mEnv:\x1b[0m
  MAW_HOST=white.local        SSH target (default: white.local)

\x1b[33mExamples:\x1b[0m
  maw spawn hermes            Create session from hermes + worktrees
  maw spawn hermes -c         Create + auto-continue all agents
  maw wake neo --new bitkub   Create worktree + start claude
  maw pulse add "Fix IME" --oracle neo --priority P1
  maw hey neo what is your status
  maw serve 8080`);
}

// --- Main ---

if (!cmd || cmd === "--help" || cmd === "-h") {
  usage();
} else if (cmd === "ls" || cmd === "list") {
  await cmdList();
} else if (cmd === "peek" || cmd === "see") {
  await cmdPeek(args[1]);
} else if (cmd === "hey" || cmd === "send" || cmd === "tell") {
  if (!args[1] || !args[2]) { console.error("usage: maw hey <agent> <message>"); process.exit(1); }
  await cmdSend(args[1], args.slice(2).join(" "));
} else if (cmd === "wake") {
  if (!args[1]) { console.error("usage: maw wake <oracle> [task] [--new <name>]"); process.exit(1); }
  const wakeOpts: { task?: string; newWt?: string } = {};
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--new" && args[i + 1]) { wakeOpts.newWt = args[++i]; }
    else if (!wakeOpts.task) { wakeOpts.task = args[i]; }
  }
  await cmdWake(args[1], wakeOpts);
} else if (cmd === "pulse") {
  const subcmd = args[1];
  if (subcmd === "add") {
    const pulseOpts: { oracle?: string; priority?: string; wt?: string } = {};
    let title = "";
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--oracle" && args[i + 1]) { pulseOpts.oracle = args[++i]; }
      else if (args[i] === "--priority" && args[i + 1]) { pulseOpts.priority = args[++i]; }
      else if ((args[i] === "--wt" || args[i] === "--worktree") && args[i + 1]) { pulseOpts.wt = args[++i]; }
      else if (!title) { title = args[i]; }
    }
    if (!title) { console.error('usage: maw pulse add "task title" --oracle <name> [--wt <repo>]'); process.exit(1); }
    await cmdPulseAdd(title, pulseOpts);
  } else {
    console.error("usage: maw pulse add <title> [opts]");
    process.exit(1);
  }
} else if (cmd === "spawn") {
  if (!args[1]) { console.error("usage: maw spawn <oracle> [--name <session>] [-c|--continue]"); process.exit(1); }
  const spawnOpts: { name?: string; continue?: boolean } = {};
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) { spawnOpts.name = args[++i]; }
    else if (args[i] === "-c" || args[i] === "--continue") { spawnOpts.continue = true; }
  }
  await cmdSpawn(args[1], spawnOpts);
} else if (cmd === "serve") {
  const { startServer } = await import("./server");
  startServer(args[1] ? +args[1] : 3456);
} else {
  // Default: agent name
  if (args.length >= 2) {
    // maw neo what's up → send
    await cmdSend(args[0], args.slice(1).join(" "));
  } else {
    // maw neo → peek
    await cmdPeek(args[0]);
  }
}
