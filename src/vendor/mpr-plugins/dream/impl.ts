import { hostExec } from "maw-js/sdk";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { loadFleet } from "maw-js/commands/shared/fleet-load";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join, basename } from "path";
import type { DreamFlags } from "./index";

const ARRA_PORT = parseInt(process.env.ORACLE_PORT || "47778", 10);
const ARRA_URL = process.env.ARRA_URL || `http://localhost:${ARRA_PORT}`;

type Category = "pain" | "plan" | "gain" | "lost" | "memory" | "feeling";
const CATEGORIES: Category[] = ["pain", "plan", "gain", "lost", "memory", "feeling"];

const ICONS: Record<Category, string> = {
  pain: "\x1b[31m●\x1b[0m", plan: "\x1b[36m●\x1b[0m", gain: "\x1b[32m●\x1b[0m",
  lost: "\x1b[90m●\x1b[0m", memory: "\x1b[35m●\x1b[0m", feeling: "\x1b[33m●\x1b[0m",
};
const HEADERS: Record<Category, string> = {
  pain: "PAIN — blocking or broken", plan: "PLAN — next steps from retros",
  gain: "GAIN — shipped this period", lost: "LOST — abandoned >90 days",
  memory: "MEMORY — patterns that repeat", feeling: "FEELING — emotional signals",
};

interface DreamItem {
  category: Category;
  title: string;
  detail: string;
  source: string;
  project: string;
  confidence: "high" | "medium" | "low";
  daysAgo: number;
  action?: string;
}

interface RepoState {
  name: string;        // display name (basename, -oracle stripped)
  dirName: string;     // actual directory basename (used for github/arra paths)
  owner: string;       // github owner extracted from ghq path
  slug: string;        // `${owner}/${dirName}` for gh CLI --repo
  path: string;
  lastCommitMsg: string;
  lastCommitDate: string;
  staleDays: number;
  uncommittedFiles: number;
  orphanedWorktrees: number;
  openPRs: number;
  recentHandoff: string | null;
}

interface ArraResult {
  content: string;
  type: string;
  source_file: string;
  score: number;
}

async function arrsSearch(query: string, limit: number = 5, type: string = "all", project?: string, mode: string = "hybrid"): Promise<ArraResult[]> {
  try {
    let url = `${ARRA_URL}/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}&mode=${mode}`;
    if (project) url += `&project=${encodeURIComponent(project)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = await res.json() as { results: ArraResult[] };
    return data.results || [];
  } catch { return []; }
}

async function checkArra(): Promise<boolean> {
  try {
    const res = await fetch(`${ARRA_URL}/api/search?q=test&limit=1`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch { return false; }
}

export async function cmdDream(flags: DreamFlags): Promise<void> {
  if (flags.help) { printHelp(); return; }
  if (flags.speculate) { await speculateFromExisting(); return; }
  if (flags.project) { await cmdDreamProject(flags.project, flags); return; }

  const dateStr = new Date().toISOString().slice(0, 10);
  console.log(`\n  \x1b[35m☾\x1b[0m \x1b[1mDream\x1b[0m — ${dateStr}\n`);

  const arrsAvailable = await checkArra();
  console.log("  \x1b[90mdreaming...\x1b[0m");
  const repos = await scanRepoStates();
  const activeRepos = repos.filter(r => r.staleDays < 14);

  const items: DreamItem[] = [];

  if (arrsAvailable) {
    for (const repo of activeRepos.slice(0, 12)) {
      items.push(...await queryProjectInsights(repo, flags));
    }
  }

  items.push(...classifyRepoState(repos, flags));
  items.push(...findPendingHandoffs(repos));

  // Forgotten: "Next Steps" from retros >14 days old that were never followed up
  const forgotten = await findForgotten(arrsAvailable);

  // Watch out: patterns that match currently active repos
  const warnings = await findWarnings(activeRepos, arrsAvailable);

  const deduped = deduplicateItems(items);

  if (flags.all) {
    // Per-project intelligence cards
    await renderProjectCards(activeRepos, deduped, arrsAvailable);
  } else {
    // Briefing mode (default — actionable, short)
    renderBriefing(deduped, forgotten, warnings, repos);
  }

  const dreamPath = saveDream(deduped, [], generateInsights(deduped, repos), repos.length, arrsAvailable, forgotten, warnings);
  console.log(`  \x1b[32m✓\x1b[0m saved → ${dreamPath}`);

  if (flags.between) {
    const specPath = writeSpeculations(deduped, repos);
    console.log(`  \x1b[32m✓\x1b[0m speculations → ${specPath}`);
  }
  console.log();
}

// ── Project deep-dive ────────────────────────────────────────

type GhItem = { number: number; title: string; state: string };

async function cmdDreamProject(projectName: string, flags: DreamFlags): Promise<void> {
  console.log(`\n  \x1b[35m⚡\x1b[0m \x1b[1mDream — deep dive: ${projectName}\x1b[0m\n`);

  const arrsAvailable = await checkArra();
  console.log(arrsAvailable ? `  \x1b[32m✓\x1b[0m oracle KB connected` : `  \x1b[33m⚠\x1b[0m oracle KB offline`);

  console.log("  \x1b[90mdreaming...\x1b[0m");
  const repos = await scanRepoStates();
  // Forgiving lookup: try directory name, display name, and either
  // form stripped of -oracle suffix. Substring match (either direction)
  // as last resort so partial names still resolve.
  const needleRaw = projectName.toLowerCase();
  const needleStripped = needleRaw.replace(/-oracle$/, "");
  const repo =
    repos.find(r => r.dirName.toLowerCase() === needleRaw) ||
    repos.find(r => r.name.toLowerCase() === needleRaw) ||
    repos.find(r => r.name.toLowerCase() === needleStripped) ||
    repos.find(r => r.dirName.toLowerCase() === needleStripped) ||
    repos.find(r => {
      const n = r.name.toLowerCase();
      return n.includes(needleStripped) || needleStripped.includes(n);
    });

  if (!repo) {
    const known = repos.map(r => r.name).slice(0, 20).join(", ");
    console.log(`\n  \x1b[31m✗\x1b[0m project "${projectName}" not found`);
    console.log(`  \x1b[90mknown: ${known}\x1b[0m\n`);
    return;
  }

  console.log(`  \x1b[90m${repo.name} — ${repo.path}\x1b[0m`);
  console.log(`  \x1b[90mlast commit: ${repo.lastCommitDate} (${repo.staleDays}d ago)\x1b[0m\n`);

  const items: DreamItem[] = [];
  if (arrsAvailable) items.push(...await queryProjectInsights(repo, flags, true));
  items.push(...classifyRepoState([repo], flags));
  items.push(...findPendingHandoffs([repo]));
  const deduped = deduplicateItems(items);
  const connections = findConnections(deduped);

  // Render all categories, no cap, always show detail
  for (const cat of CATEGORIES) {
    const catItems = deduped.filter(i => i.category === cat);
    if (catItems.length === 0) continue;
    console.log(`  ${ICONS[cat]} \x1b[1m${HEADERS[cat]}\x1b[0m (${catItems.length})`);
    for (const item of catItems) {
      const age = item.daysAgo <= 1 ? "\x1b[32mtoday\x1b[0m" : item.daysAgo <= 7 ? `\x1b[33m${item.daysAgo}d\x1b[0m` : `\x1b[90m${item.daysAgo}d\x1b[0m`;
      const conf = item.confidence === "high" ? "\x1b[32m▸\x1b[0m" : item.confidence === "medium" ? "\x1b[33m▸\x1b[0m" : "\x1b[90m▸\x1b[0m";
      console.log(`    ${conf} ${item.title} \x1b[90m(${age})\x1b[0m`);
      if (item.detail) console.log(`      \x1b[90m${item.detail.slice(0, 150)}\x1b[0m`);
      if (item.action) console.log(`      \x1b[36m→ ${item.action}\x1b[0m`);
    }
    console.log();
  }

  if (connections.length > 0) {
    console.log("  \x1b[36m⚡ Connections\x1b[0m");
    for (const c of connections) {
      console.log(`    \x1b[90m${c.from.title.slice(0, 35)}\x1b[0m → \x1b[36m${c.relation}\x1b[0m → \x1b[90m${c.to.title.slice(0, 35)}\x1b[0m`);
    }
    console.log();
  }

  // Git log
  const gitLog = await gitLogLines(repo.path, 15);
  if (gitLog.length > 0) {
    console.log("  \x1b[90m📋 Recent commits\x1b[0m");
    for (const line of gitLog) console.log(`    \x1b[90m${line}\x1b[0m`);
    console.log();
  }

  // GitHub issues & PRs
  const gh = await githubIssuesAndPRs(repo.slug);
  if (gh.issues.length > 0) {
    console.log("  \x1b[90m🐙 Open issues\x1b[0m");
    for (const i of gh.issues) console.log(`    ${i}`);
    console.log();
  }
  if (gh.prs.length > 0) {
    console.log("  \x1b[90m🐙 Open PRs\x1b[0m");
    for (const p of gh.prs) console.log(`    ${p}`);
    console.log();
  }

  // Save
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const psiDir = join(process.cwd(), "ψ", "writing", "dreams", "project");
  mkdirSync(psiDir, { recursive: true });
  const filepath = join(psiDir, `${dateStr}_${repo.name}_deep.md`);
  const lines: string[] = [`# Dream Deep Dive — ${repo.name}`, "", `**Path**: ${repo.path}`, `**Last commit**: ${repo.lastCommitDate} (${repo.staleDays}d ago)`, `**Oracle KB**: ${arrsAvailable ? "connected" : "offline"}`, `**Time**: ${now.toISOString()}`, ""];
  for (const cat of CATEGORIES) {
    const ci = deduped.filter(i => i.category === cat);
    if (ci.length === 0) continue;
    lines.push(`## ${HEADERS[cat]} (${ci.length})`, "");
    for (const item of ci) {
      lines.push(`- **${item.title}** [${item.confidence}, ${item.daysAgo}d]`);
      if (item.detail) lines.push(`  ${item.detail.slice(0, 200)}`);
      if (item.action) lines.push(`  → \`${item.action}\``);
    }
    lines.push("");
  }
  if (gitLog.length > 0) { lines.push("## Recent Commits", ""); for (const l of gitLog) lines.push(`- ${l}`); lines.push(""); }
  if (gh.issues.length > 0) { lines.push("## Open Issues", ""); for (const i of gh.issues) lines.push(`- ${i}`); lines.push(""); }
  if (gh.prs.length > 0) { lines.push("## Open PRs", ""); for (const p of gh.prs) lines.push(`- ${p}`); lines.push(""); }
  writeFileSync(filepath, lines.join("\n"));
  console.log(`  \x1b[32m✓\x1b[0m saved → ${filepath}\n`);
}

async function gitLogLines(repoPath: string, n: number): Promise<string[]> {
  try {
    const out = await hostExec(`git -C '${repoPath}' log -${n} --format='%h %ad %s' --date=short 2>/dev/null`);
    return out.trim().split("\n").filter(Boolean);
  } catch { return []; }
}

async function githubIssuesAndPRs(slug: string): Promise<{ issues: string[]; prs: string[] }> {
  const result = { issues: [] as string[], prs: [] as string[] };
  try {
    const issueJson = await hostExec(`gh issue list --repo ${slug} --state open --limit 10 --json number,title,state 2>/dev/null`);
    const issues = JSON.parse(issueJson) as GhItem[];
    if (Array.isArray(issues)) result.issues = issues.map(i => `#${i.number} ${i.title}`);
  } catch { /* gh not available */ }
  try {
    const prJson = await hostExec(`gh pr list --repo ${slug} --state open --limit 10 --json number,title,state 2>/dev/null`);
    const prs = JSON.parse(prJson) as GhItem[];
    if (Array.isArray(prs)) result.prs = prs.map(p => `#${p.number} ${p.title}`);
  } catch { /* gh not available */ }
  return result;
}

// ── Per-project semantic queries ─────────────────────────────

async function queryProjectInsights(repo: RepoState, flags: DreamFlags, deep: boolean = false): Promise<DreamItem[]> {
  const items: DreamItem[] = [];
  const focused = flags.pain || flags.plan || flags.gain;
  const limit = deep ? 10 : 3;
  const proj = `github.com/${repo.slug}`;

  if (!focused || flags.pain) {
    const results = await arrsSearch("what went wrong what error occurred how to fix", limit, "learning", proj);
    for (const r of results) {
      if (!deep && !isRecentEnough(r.source_file, 30)) continue;
      const title = extractTitle(r.content, r.source_file);
      if (!title || isNoise(title)) continue;
      items.push({
        category: "pain", title, detail: extractDetail(r.content),
        source: r.source_file, project: repo.name,
        confidence: r.score > 0.6 ? "high" : "medium",
        daysAgo: daysFromFile(r.source_file),
        action: `maw workon ${repo.name}`,
      });
    }
  }

  if (!focused || flags.plan) {
    const results = await arrsSearch("what should we build next what comes after roadmap", limit, "retro", proj);
    for (const r of results) {
      if (!deep && !isRecentEnough(r.source_file, 14)) continue;
      const nextSteps = extractSection(r.content, "Next Steps") || extractSection(r.content, "Pending");
      if (!nextSteps) continue;
      items.push({
        category: "plan", title: `${repo.name} — ${nextSteps.slice(0, 80)}`,
        detail: nextSteps, source: r.source_file, project: repo.name,
        confidence: "high", daysAgo: daysFromFile(r.source_file),
      });
    }
  }

  if (!focused || flags.gain) {
    const results = await arrsSearch("what shipped what was delivered what went live released", limit, "retro", proj);
    for (const r of results) {
      if (!deep && !isRecentEnough(r.source_file, 14)) continue;
      const summary = extractSection(r.content, "Session Summary") || extractSection(r.content, "Summary") || extractSection(r.content, "What Got Done");
      if (!summary) continue;
      items.push({
        category: "gain", title: `${repo.name} — ${summary.slice(0, 80)}`,
        detail: summary, source: r.source_file, project: repo.name,
        confidence: "high", daysAgo: daysFromFile(r.source_file),
      });
    }
  }

  if (!focused) {
    const memResults = await arrsSearch("pattern appeared again root cause lesson insight", deep ? 8 : 2, "learning", proj);
    for (const r of memResults) {
      const title = extractTitle(r.content, r.source_file);
      if (!title || isNoise(title)) continue;
      items.push({
        category: "memory", title, detail: extractDetail(r.content),
        source: r.source_file, project: repo.name,
        confidence: "high", daysAgo: daysFromFile(r.source_file),
      });
    }
  }

  if (!focused || deep) {
    const feelResults = await arrsSearch("energy momentum breakthrough frustration tension", deep ? 5 : 2, "retro", proj, "vector");
    for (const r of feelResults) {
      const title = extractTitle(r.content, r.source_file);
      if (!title || isNoise(title)) continue;
      items.push({
        category: "feeling", title, detail: extractDetail(r.content),
        source: r.source_file, project: repo.name,
        confidence: "low", daysAgo: daysFromFile(r.source_file),
      });
    }
  }

  return items;
}

// ── Repo state classification ────────────────────────────────

function classifyRepoState(repos: RepoState[], flags: DreamFlags): DreamItem[] {
  const items: DreamItem[] = [];
  const focused = flags.pain || flags.plan || flags.gain;

  for (const repo of repos) {
    if (!focused || flags.pain) {
      if (repo.uncommittedFiles > 5) {
        items.push({
          category: "pain", title: `${repo.name} — ${repo.uncommittedFiles} uncommitted files`,
          detail: `Last: "${repo.lastCommitMsg}"`, source: repo.path, project: repo.name,
          confidence: "high", daysAgo: 0, action: `cd ${repo.path} && git status`,
        });
      }
      if (repo.orphanedWorktrees > 0) {
        items.push({
          category: "pain", title: `${repo.name} — ${repo.orphanedWorktrees} orphaned worktree(s)`,
          detail: "Worktrees without active windows — run maw done or git worktree prune",
          source: repo.path, project: repo.name,
          confidence: "medium", daysAgo: 0, action: `git -C ${repo.path} worktree list`,
        });
      }
    }

    if (repo.staleDays > 90) {
      items.push({
        category: "lost", title: `${repo.name} — silent ${repo.staleDays}d`,
        detail: `Last: ${repo.lastCommitDate} — "${repo.lastCommitMsg}"`,
        source: repo.path, project: repo.name,
        confidence: "high", daysAgo: repo.staleDays,
      });
    }
  }

  return items;
}

// ── Forgotten: planned but never done ────────────────────────

interface ForgottenItem {
  text: string;
  source: string;
  daysAgo: number;
  project: string;
}

async function findForgotten(arrsAvailable: boolean): Promise<ForgottenItem[]> {
  if (!arrsAvailable) return [];
  const results = await arrsSearch("next steps should build need to fix pending todo", 15, "retro");
  const forgotten: ForgottenItem[] = [];

  for (const r of results) {
    const age = daysFromFile(r.source_file);
    if (age < 14 || age > 60) continue; // 14-60 day window

    const nextSteps = extractSection(r.content, "Next Steps") || extractSection(r.content, "Pending") || extractSection(r.content, "Next Session");
    if (!nextSteps) continue;

    const lines = nextSteps.split(/[-•*\n]/).map(l => l.trim()).filter(l => l.length > 15);
    for (const line of lines.slice(0, 2)) {
      const cleaned = line.replace(/^\[.\]\s*/, "").replace(/^\d+\.\s*/, "").slice(0, 100);
      if (/\b(done|completed|merged|shipped|closed|no pending|session complete)\b/i.test(cleaned)) continue;
      if (/\b(continue|as required|any other)\b/i.test(cleaned)) continue;
      const repo = extractRepo(r.source_file);
      forgotten.push({ text: cleaned, source: r.source_file, daysAgo: age, project: repo });
    }
  }

  const seen = new Set<string>();
  return forgotten.filter(f => {
    const key = f.text.toLowerCase().slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.daysAgo - b.daysAgo).slice(0, 5);
}

// ── Warnings: recurring patterns ─────────────────────────────

interface Warning {
  text: string;
  project: string;
}

async function findWarnings(activeRepos: RepoState[], arrsAvailable: boolean): Promise<Warning[]> {
  if (!arrsAvailable) return [];
  const warnings: Warning[] = [];

  // Find learnings mentioning "again", "3 times", "keeps happening", "same pattern"
  const results = await arrsSearch("keeps happening same bug again recurring repeated broke again", 10, "learning");
  const activeNames = new Set(activeRepos.map(r => r.name));

  for (const r of results) {
    const repo = extractRepo(r.source_file);
    if (!activeNames.has(repo) && !activeNames.has(repo + "-oracle")) continue;
    const title = extractTitle(r.content, r.source_file);
    if (!title || isNoise(title)) continue;
    warnings.push({ text: `${repo}: ${title}`, project: repo });
  }

  // Deduplicate
  const seen = new Set<string>();
  return warnings.filter(w => {
    const key = w.text.toLowerCase().slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

// ── Briefing render (default mode) ───────────────────────────

function renderBriefing(items: DreamItem[], forgotten: ForgottenItem[], warnings: Warning[], repos: RepoState[]): void {
  // Continue From Yesterday: handoff items with parsed priority
  const handoffItems = items.filter(i => i.category === "plan" && i.detail.match(/^(Verify|Soon|Later)/));
  const verifyItems = handoffItems.filter(i => i.detail.startsWith("Verify"));
  const soonItems = handoffItems.filter(i => i.detail.startsWith("Soon"));
  const focus = [...verifyItems, ...soonItems].slice(0, 5);

  if (focus.length > 0) {
    console.log("  \x1b[36m📌 Continue From Yesterday\x1b[0m");
    for (let i = 0; i < focus.length; i++) {
      const item = focus[i]!;
      const prio = item.detail.split(":")[0] || "";
      const prioColor = prio === "Verify" ? "\x1b[31m" : "\x1b[33m";
      console.log(`    ${i + 1}. ${item.title} ${prioColor}[${prio}]\x1b[0m`);
    }
    console.log();
  }

  // Category highlights: top 3 per category (from arra)
  const nonHandoff = items.filter(i => !i.detail.match(/^(Verify|Soon|Later)/));
  const catsToShow: [Category, number][] = [["pain", 3], ["gain", 3], ["plan", 2], ["memory", 2]];
  for (const [cat, limit] of catsToShow) {
    const catItems = nonHandoff.filter(i => i.category === cat);
    if (catItems.length === 0) continue;
    console.log(`  ${ICONS[cat]} \x1b[1m${HEADERS[cat]}\x1b[0m (${catItems.length})`);
    for (const item of catItems.slice(0, limit)) {
      const age = item.daysAgo <= 1 ? "\x1b[32mtoday\x1b[0m" : item.daysAgo <= 7 ? `\x1b[33m${item.daysAgo}d\x1b[0m` : `\x1b[90m${item.daysAgo}d\x1b[0m`;
      console.log(`    ${item.title} \x1b[90m(${age})\x1b[0m`);
    }
    if (catItems.length > limit) console.log(`    \x1b[90m… ${catItems.length - limit} more (--all)\x1b[0m`);
    console.log();
  }

  if (forgotten.length > 0) {
    console.log("  \x1b[31m🔴 Forgotten\x1b[0m \x1b[90m(planned but never done)\x1b[0m");
    for (const f of forgotten) {
      console.log(`    \x1b[90m${f.daysAgo}d ago\x1b[0m ${f.project}: ${f.text}`);
    }
    console.log();
  }

  if (warnings.length > 0) {
    console.log("  \x1b[33m⚠️  Watch Out\x1b[0m");
    for (const w of warnings) {
      console.log(`    ${w.text}`);
    }
    console.log();
  }

  const active = repos.filter(r => r.staleDays < 7).length;
  const stale = repos.filter(r => r.staleDays > 90).length;
  console.log(`  \x1b[90m📊 ${active} active${stale > 0 ? ` | ${stale} stale` : ""}\x1b[0m`);
  console.log();
}

// ── Per-project cards (--all mode) ───────────────────────────

async function renderProjectCards(activeRepos: RepoState[], _items: DreamItem[], arrsAvailable: boolean): Promise<void> {
  const shown = activeRepos.slice(0, 10);
  for (const repo of shown) {
    const momentum = await getProjectMomentum(repo.path);
    const bar = momentumBar(momentum.week, 30);

    console.log(`  \x1b[1m● ${repo.name}\x1b[0m  ${bar} ${momentum.week}/week`);

    if (arrsAvailable) {
      const wins = await getProjectWins(repo.name);
      for (const w of wins.slice(0, 2)) {
        console.log(`    \x1b[32m✓\x1b[0m ${w}`);
      }

      const friction = await getProjectSection(repo.name, "friction improve problem could be better", "retro", "What Could Improve");
      for (const f of friction.slice(0, 1)) {
        console.log(`    \x1b[33m⚠\x1b[0m ${f}`);
      }

      const patterns = await getProjectSection(repo.name, "pattern lesson root cause always never", "learning", "");
      for (const p of patterns.slice(0, 1)) {
        console.log(`    \x1b[35m🔗\x1b[0m ${p}`);
      }
    }

    console.log(`    \x1b[36m→ maw workon ${repo.name}\x1b[0m`);
    console.log();
  }

  console.log(`  \x1b[90m📊 ${shown.length}/${activeRepos.length} active repos shown\x1b[0m`);
  console.log();
}

async function getProjectMomentum(repoPath: string): Promise<{ week: number; month: number }> {
  let week = 0, month = 0;
  try {
    week = parseInt((await hostExec(`git -C '${repoPath}' log --oneline --since='7 days ago' 2>/dev/null | wc -l`)).trim()) || 0;
    month = parseInt((await hostExec(`git -C '${repoPath}' log --oneline --since='30 days ago' 2>/dev/null | wc -l`)).trim()) || 0;
  } catch { /* ignore */ }
  return { week, month };
}

function momentumBar(commits: number, maxScale: number): string {
  const filled = Math.min(10, Math.round((commits / maxScale) * 10));
  return "\x1b[32m" + "█".repeat(filled) + "\x1b[90m" + "░".repeat(10 - filled) + "\x1b[0m";
}

async function getProjectWins(repoName: string): Promise<string[]> {
  const repoVariants = [repoName, `${repoName}-oracle`, repoName.toLowerCase()];
  const results = await arrsSearch(`${repoName} shipped completed deployed merged`, 8, "retro");
  const items: string[] = [];

  for (const r of results) {
    if (!repoVariants.some(v => r.source_file.includes(v))) continue;
    // Get session summary as a single clean sentence
    const summary = extractSection(r.content, "Session Summary") || extractSection(r.content, "Summary");
    if (summary) {
      const firstSentence = summary.split(/[.!]\s/).filter(s => s.length > 15)[0];
      if (firstSentence) items.push(firstSentence.slice(0, 80));
    }
    if (items.length >= 2) break;
  }
  return items;
}

async function getProjectSection(repoName: string, query: string, type: string, sectionName: string): Promise<string[]> {
  const repoVariants = [repoName, `${repoName}-oracle`, repoName.toLowerCase()];
  const results = await arrsSearch(`${repoName} ${query}`, 8, type);
  const items: string[] = [];
  for (const r of results) {
    if (!repoVariants.some(v => r.source_file.includes(v))) continue;
    if (!isRecentEnough(r.source_file, 30)) continue;

    if (!sectionName) {
      // No section — extract title from content or filename
      const title = extractTitle(r.content, r.source_file);
      if (title && !isNoise(title)) items.push(title.slice(0, 80));
    } else {
      const section = extractSection(r.content, sectionName);
      if (!section) continue;
      const firstSentence = section.split(/[.!]\s/).filter(s => s.length > 15)[0];
      if (firstSentence) items.push(firstSentence.slice(0, 80));
    }
    if (items.length >= 3) break;
  }
  return items.slice(0, 3);
}

// ── Handoff detection ────────────────────────────────────────

interface HandoffItem {
  priority: string;
  item: string;
  context: string;
  project: string;
  source: string;
  daysAgo: number;
}

function findPendingHandoffs(repos: RepoState[]): DreamItem[] {
  const items: DreamItem[] = [];
  for (const repo of repos) {
    if (!repo.recentHandoff) continue;
    const content = safeRead(repo.recentHandoff);
    if (!content) continue;
    const age = daysFromFile(repo.recentHandoff);
    const parsed = parseHandoffItems(content, repo.name, repo.recentHandoff, age);
    for (const h of parsed) {
      items.push({
        category: "plan",
        title: `${h.item.slice(0, 80)}`,
        detail: h.context ? `${h.priority}: ${h.context}` : h.priority,
        source: h.source, project: h.project,
        confidence: h.priority === "Verify" ? "high" : h.priority === "Soon" ? "high" : "medium",
        daysAgo: h.daysAgo,
      });
    }
  }
  return items;
}

function parseHandoffItems(content: string, project: string, source: string, daysAgo: number): HandoffItem[] {
  const items: HandoffItem[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Parse markdown table rows: | Priority | Item | Context |
    const tableMatch = line.match(/^\|\s*\*?\*?(\w+)\*?\*?\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|$/);
    if (tableMatch && !line.includes("---") && !line.includes("Priority")) {
      const [, priority, item, context] = tableMatch;
      if (priority && item) {
        items.push({ priority: priority.replace(/\*/g, ""), item: item.trim(), context: (context || "").trim(), project, source, daysAgo });
      }
      continue;
    }

    // Parse checkbox: - [ ] item
    const checkMatch = line.match(/^[-*]\s*\[\s*\]\s+(.+)/);
    if (checkMatch) {
      items.push({ priority: "Soon", item: checkMatch[1]!.trim(), context: "", project, source, daysAgo });
    }
  }

  return items;
}

// ── Repo scanning ────────────────────────────────────────────

async function scanRepoStates(): Promise<RepoState[]> {
  const reposRoot = join(getGhqRoot(), "github.com");
  const fleet = loadFleet();
  const results: RepoState[] = [];
  const now = Date.now();
  const seen = new Set<string>();

  const repoPaths: string[] = [];
  for (const sess of fleet) {
    for (const win of sess.windows || []) {
      if (win.repo) {
        const p = join(reposRoot, win.repo);
        if (!seen.has(p)) { seen.add(p); repoPaths.push(p); }
      }
    }
  }
  try {
    const ghqList = await hostExec("ghq list -p 2>/dev/null");
    for (const line of ghqList.trim().split("\n").filter(Boolean)) {
      if (existsSync(join(line, "ψ")) && !seen.has(line)) {
        seen.add(line); repoPaths.push(line);
      }
    }
  } catch { /* ghq not available */ }

  for (const repoPath of repoPaths) {
    if (!existsSync(repoPath)) continue;
    const dirName = basename(repoPath);
    const name = dirName.replace(/-oracle$/i, "");
    // Extract owner from ghq path (.../github.com/<owner>/<dirName>)
    const pathParts = repoPath.split("/");
    const owner = pathParts[pathParts.length - 2] || "unknown";
    const slug = `${owner}/${dirName}`;
    let lastCommitMsg = "", lastCommitDate = "", staleDays = 999;
    let uncommittedFiles = 0, orphanedWorktrees = 0, openPRs = 0;

    try {
      lastCommitMsg = (await hostExec(`git -C '${repoPath}' log -1 --format='%s' 2>/dev/null`)).trim();
      const ts = parseInt((await hostExec(`git -C '${repoPath}' log -1 --format='%ct' 2>/dev/null`)).trim()) * 1000;
      lastCommitDate = new Date(ts).toISOString().slice(0, 10);
      staleDays = Math.floor((now - ts) / 86_400_000);
    } catch { /* not a git repo */ }

    try {
      const status = (await hostExec(`git -C '${repoPath}' status --porcelain 2>/dev/null`)).trim();
      uncommittedFiles = status ? status.split("\n").length : 0;
    } catch { /* ignore */ }

    try {
      const wt = (await hostExec(`git -C '${repoPath}' worktree list --porcelain 2>/dev/null`)).trim();
      const worktrees = wt.split("\n\n").filter(w => w.includes("worktree") && !w.includes("bare"));
      orphanedWorktrees = Math.max(0, worktrees.length - 1);
    } catch { /* ignore */ }

    const recentHandoff = findLatestFile(join(repoPath, "ψ", "inbox", "handoff"), 7);

    results.push({ name, dirName, owner, slug, path: repoPath, lastCommitMsg, lastCommitDate, staleDays, uncommittedFiles, orphanedWorktrees, openPRs, recentHandoff });
  }

  return results.sort((a, b) => a.staleDays - b.staleDays);
}

// ── Extraction helpers ───────────────────────────────────────

export function extractTitle(content: string, sourceFile: string): string {
  const lines = content.split("\n");
  const h1 = lines.find(l => l.startsWith("# "))?.replace(/^#+\s*/, "");
  if (h1 && h1.length > 10 && !h1.startsWith("---")) return h1.slice(0, 100);

  for (const l of lines) {
    const s = l.replace(/^[-*#\s]+/, "");
    if (/^(session\s+)?summary:/i.test(s)) {
      const v = s.replace(/^(session\s+)?summary:\s*/i, "").trim();
      if (v.length > 15) return v.slice(0, 100);
    }
  }

  const repo = extractRepo(sourceFile);
  const fname = sourceFile.split("/").pop()?.replace(/\.md$/, "") || "";
  const cleaned = fname.replace(/^\d{2}\.\d{2}_/, "").replace(/^\d{4}-\d{2}-\d{2}_/, "").replace(/[-_]/g, " ");
  if (cleaned.length > 10) return `${repo} — ${cleaned.slice(0, 80)}`;

  return "";
}

export function extractSection(content: string, heading: string): string | null {
  const lines = content.split("\n");
  const headingLower = heading.toLowerCase();
  let capturing = false;
  const captured: string[] = [];

  for (const line of lines) {
    const stripped = line.replace(/^[-*#\s]+/, "").replace(/:$/, "");
    if (stripped.toLowerCase().startsWith(headingLower)) {
      // Inline value: "Next Steps: - do X"
      const afterColon = line.split(":").slice(1).join(":").trim();
      if (afterColon.length > 10) { captured.push(afterColon); capturing = true; continue; }
      capturing = true;
      continue;
    }
    if (capturing) {
      if (line.startsWith("## ") || line.startsWith("# ") || (line.startsWith("**") && line.endsWith("**"))) break;
      if (line.trim()) captured.push(line.trim());
      if (captured.length >= 5) break;
    }
  }

  if (captured.length === 0) return null;
  return captured.join(" ").replace(/^[-*\s]+/, "").slice(0, 200);
}

export function extractDetail(content: string): string {
  const section = extractSection(content, "Summary") || extractSection(content, "What Happened");
  if (section) return section;
  const lines = content.split("\n");
  const first = lines.find(l => l.trim().length > 30 && !l.startsWith("---") && !/^(tags?|created|source|project|title):/i.test(l.trim()));
  return first?.trim().slice(0, 150) || "";
}

export function extractRepo(sourceFile: string): string {
  const parts = sourceFile.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "ψ" && i > 0) {
      let repoDir = parts[i - 1]!;
      if (repoDir.startsWith("agent-") || repoDir === "worktrees") {
        for (let j = i - 2; j >= 0; j--) {
          if (parts[j] !== ".claude" && parts[j] !== "worktrees") { repoDir = parts[j]!; break; }
        }
      }
      return repoDir.replace(/-oracle$/i, "");
    }
  }
  return "unknown";
}

export function isNoise(title: string): boolean {
  return /trade|sell|buy|eth|btc|usdt|position|close|open|long|short/i.test(title);
}

function isRecentEnough(sourceFile: string, maxDays: number): boolean {
  return daysFromFile(sourceFile) <= maxDays;
}

export function daysFromFile(sourceFile: string): number {
  const match = sourceFile.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (!match) return 999;
  const fileDate = new Date(`${match[1]}-${match[2]}-${match[3]}`);
  return Math.floor((Date.now() - fileDate.getTime()) / 86_400_000);
}

function safeRead(filepath: string): string | null {
  try { return readFileSync(filepath, "utf-8"); } catch { return null; }
}

function findLatestFile(dir: string, maxDaysOld: number): string | null {
  if (!existsSync(dir)) return null;
  const now = Date.now();
  const cutoff = now - maxDaysOld * 86_400_000;
  let latest: { path: string; mtime: number } | null = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const full = join(dir, f);
      const mt = statSync(full).mtimeMs;
      if (mt > cutoff && (!latest || mt > latest.mtime)) latest = { path: full, mtime: mt };
    }
  } catch { /* ignore */ }
  return latest?.path ?? null;
}

// ── Deduplication & Connections ──────────────────────────────

export function deduplicateItems(items: DreamItem[]): DreamItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.category}:${item.project}:${item.title.toLowerCase().slice(0, 40)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface Connection { from: DreamItem; to: DreamItem; relation: string }

function findConnections(items: DreamItem[]): Connection[] {
  const connections: Connection[] = [];
  const byProject = new Map<string, DreamItem[]>();
  for (const item of items) {
    if (!byProject.has(item.project)) byProject.set(item.project, []);
    byProject.get(item.project)!.push(item);
  }

  // Within-project connections: pain ↔ plan, memory → pain
  for (const [, projectItems] of byProject) {
    const pains = projectItems.filter(i => i.category === "pain");
    const plans = projectItems.filter(i => i.category === "plan");
    const memories = projectItems.filter(i => i.category === "memory");

    for (const pain of pains) {
      const matchingPlan = plans.find(p => shareKeywords(pain.title, p.title, 2));
      if (matchingPlan) {
        connections.push({ from: pain, to: matchingPlan, relation: "has fix planned" });
      }
    }
    for (const mem of memories) {
      const related = pains.find(p => shareKeywords(mem.title, p.title, 2));
      if (related) {
        connections.push({ from: mem, to: related, relation: "could prevent" });
      }
    }
  }

  // Cross-project: same pattern in different repos
  const memories = items.filter(i => i.category === "memory");
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      if (memories[i]!.project !== memories[j]!.project && shareKeywords(memories[i]!.title, memories[j]!.title, 3)) {
        connections.push({ from: memories[i]!, to: memories[j]!, relation: "same pattern across repos" });
      }
    }
  }

  return connections;
}

export function shareKeywords(a: string, b: string, threshold: number): boolean {
  const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "have", "been", "session", "retrospective", "lesson", "learned", "learning"]);
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stop.has(w)));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stop.has(w)));
  let n = 0;
  for (const w of wa) { if (wb.has(w)) n++; }
  return n >= threshold;
}

// ── Insights ─────────────────────────────────────────────────

function generateInsights(items: DreamItem[], repos: RepoState[]): string[] {
  const insights: string[] = [];
  const pains = items.filter(i => i.category === "pain");
  const plans = items.filter(i => i.category === "plan");
  const losts = items.filter(i => i.category === "lost");
  const active = repos.filter(r => r.staleDays < 7);

  if (active.length > 0) insights.push(`Active: ${active.length} repos touched this week`);

  // Repos with most pain
  const painByProject = new Map<string, number>();
  for (const p of pains) painByProject.set(p.project, (painByProject.get(p.project) || 0) + 1);
  const hotspots = [...painByProject.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  if (hotspots.length > 0) {
    insights.push(`Hotspots: ${hotspots.map(([p, n]) => `${p} (${n})`).join(", ")}`);
  }

  if (plans.length > 0 && pains.length > 0) {
    const covered = pains.filter(p => plans.some(pl => pl.project === p.project));
    insights.push(`Coverage: ${covered.length}/${pains.length} pains have plans in the same project`);
  }

  if (losts.length > 0) insights.push(`Forgotten: ${losts.length} repos silent >90d`);

  // Uncommitted work risk
  const uncommitted = repos.filter(r => r.uncommittedFiles > 5);
  if (uncommitted.length > 0) {
    insights.push(`At risk: ${uncommitted.map(r => `${r.name} (${r.uncommittedFiles} files)`).join(", ")}`);
  }

  return insights;
}

// ── Render ───────────────────────────────────────────────────

function renderDream(items: DreamItem[], connections: Connection[], insights: string[], flags: DreamFlags): void {
  const focused = flags.pain || flags.plan || flags.gain;

  for (const cat of CATEGORIES) {
    if (focused && cat !== "pain" && cat !== "plan" && cat !== "gain") continue;
    if (focused && !flags[cat as keyof DreamFlags]) continue;

    const catItems = items.filter(i => i.category === cat);
    if (catItems.length === 0) continue;

    console.log(`  ${ICONS[cat]} \x1b[1m${HEADERS[cat]}\x1b[0m (${catItems.length})`);
    for (const item of catItems.slice(0, 8)) {
      const conf = item.confidence === "high" ? "\x1b[32m▸\x1b[0m" : item.confidence === "medium" ? "\x1b[33m▸\x1b[0m" : "\x1b[90m▸\x1b[0m";
      const age = item.daysAgo <= 1 ? "\x1b[32mtoday\x1b[0m" : item.daysAgo <= 7 ? `\x1b[33m${item.daysAgo}d\x1b[0m` : `\x1b[90m${item.daysAgo}d\x1b[0m`;
      console.log(`    ${conf} ${item.title} \x1b[90m(${age})\x1b[0m`);
      if (flags.all && item.detail) console.log(`      \x1b[90m${item.detail.slice(0, 120)}\x1b[0m`);
      if (flags.all && item.action) console.log(`      \x1b[36m→ ${item.action}\x1b[0m`);
    }
    if (catItems.length > 8) console.log(`    \x1b[90m… ${catItems.length - 8} more\x1b[0m`);
    console.log();
  }

  if (connections.length > 0) {
    console.log("  \x1b[36m⚡ Connections\x1b[0m");
    for (const c of connections.slice(0, 5)) {
      console.log(`    ${c.from.project}:\x1b[90m${c.from.title.slice(0, 30)}\x1b[0m → \x1b[36m${c.relation}\x1b[0m → ${c.to.project}:\x1b[90m${c.to.title.slice(0, 30)}\x1b[0m`);
    }
    console.log();
  }

  if (insights.length > 0) {
    console.log("  \x1b[33m💡 Insights\x1b[0m");
    for (const i of insights) console.log(`    ${i}`);
    console.log();
  }
}

// ── Save ─────────────────────────────────────────────────────

function saveDream(items: DreamItem[], connections: Connection[], insights: string[], repoCount: number, arrsUsed: boolean, forgotten: ForgottenItem[] = [], warnings: Warning[] = []): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 16).replace(":", "-");
  const psiDir = join(process.cwd(), "ψ", "writing", "dreams");
  mkdirSync(psiDir, { recursive: true });
  const filepath = join(psiDir, `${dateStr}_${timeStr}_dream.md`);

  const lines: string[] = [];
  lines.push(`# Dream — ${dateStr}`, "");
  lines.push(`**Scanned**: ${repoCount} repos | **Oracle KB**: ${arrsUsed ? "connected" : "offline"}`);
  lines.push(`**Time**: ${now.toISOString()}`, "");

  if (forgotten.length > 0) {
    lines.push("## Forgotten (planned but never done)", "");
    for (const f of forgotten) lines.push(`- **${f.text}** — ${f.daysAgo}d ago (${f.project})`);
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const w of warnings) lines.push(`- ${w.text}`);
    lines.push("");
  }

  for (const cat of CATEGORIES) {
    const ci = items.filter(i => i.category === cat);
    if (ci.length === 0) continue;
    lines.push(`## ${HEADERS[cat]} (${ci.length})`, "");
    for (const item of ci) {
      lines.push(`- **${item.title}** [${item.confidence}, ${item.daysAgo}d ago]`);
      if (item.detail) lines.push(`  ${item.detail.slice(0, 150)}`);
      if (item.action) lines.push(`  → \`${item.action}\``);
    }
    lines.push("");
  }

  if (connections.length > 0) {
    lines.push("## Connections", "");
    for (const c of connections) lines.push(`- ${c.from.title.slice(0, 50)} → **${c.relation}** → ${c.to.title.slice(0, 50)}`);
    lines.push("");
  }

  if (insights.length > 0) {
    lines.push("## Insights", "");
    for (const i of insights) lines.push(`- ${i}`);
    lines.push("");
  }

  writeFileSync(filepath, lines.join("\n"));
  return filepath;
}

function writeSpeculations(items: DreamItem[], repos: RepoState[]): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const dir = join(process.cwd(), "ψ", "memory", "morpheus");
  mkdirSync(dir, { recursive: true });
  const filepath = join(dir, `${dateStr}_speculations.md`);

  const lines: string[] = [];
  lines.push(`# Morpheus — Speculations`, "");
  lines.push(`**Dreamed**: ${now.toISOString()}`, "");

  lines.push("## Likely next session", "");
  const active = repos.filter(r => r.staleDays < 3).slice(0, 5);
  for (const r of active) lines.push(`- [HIGH] ${r.name} — last: "${r.lastCommitMsg.slice(0, 60)}"`);

  const plans = items.filter(i => i.category === "plan").slice(0, 3);
  for (const p of plans) lines.push(`- [MEDIUM] ${p.title.slice(0, 80)}`);
  lines.push("");

  lines.push("## Risks", "");
  const pains = items.filter(i => i.category === "pain" && i.confidence === "high").slice(0, 5);
  for (const p of pains) lines.push(`- ${p.title}${p.action ? ` → \`${p.action}\`` : ""}`);
  lines.push("");

  writeFileSync(filepath, lines.join("\n"));
  return filepath;
}

async function speculateFromExisting(): Promise<void> {
  console.log("\n  \x1b[35m☾\x1b[0m \x1b[1mMorpheus\x1b[0m — speculating from existing knowledge\n");
  const dreamDir = join(process.cwd(), "ψ", "writing", "dreams");
  const morpheusDir = join(process.cwd(), "ψ", "memory", "morpheus");

  for (const [label, dir] of [["Latest dream", dreamDir], ["Latest speculation", morpheusDir]] as const) {
    const f = findLatestFile(dir, 30);
    if (!f) continue;
    console.log(`  \x1b[36m${label}:\x1b[0m \x1b[90m${basename(f)}\x1b[0m`);
    const content = readFileSync(f, "utf-8");
    const items = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 5);
    for (const line of items) console.log(`    ${line}`);
    console.log();
  }
}

function printHelp(): void {
  console.log("usage: maw dream [flags]\n");
  console.log("  maw dream                # scan + oracle KB → categorized findings");
  console.log("  maw dream --pain         # what's broken or blocking");
  console.log("  maw dream --plan         # next steps from recent retros + handoffs");
  console.log("  maw dream --gain         # what shipped recently");
  console.log("  maw dream --all          # show details + suggested actions");
  console.log("  maw dream --project X    # deep dive on one project (-p shorthand)");
  console.log("  maw dream --speculate    # review existing dreams + speculations");
  console.log("  maw dream --between      # scan + write predictions for next session");
  console.log("\nRequires arra-oracle on port 47778 for semantic search.");
  console.log("Falls back to git-only scan if offline.\n");
  console.log("Output: ψ/writing/dreams/ + ψ/memory/morpheus/");
}

export const __dreamImplCoverageHooks = {
  findConnections,
  generateInsights,
  printHelp,
  renderDream,
  saveDream,
  speculateFromExisting,
  writeSpeculations,
};
