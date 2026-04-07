import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { ssh } from "../ssh";
import { tmux } from "../tmux";
import { loadConfig } from "../config";
import { loadFleetEntries } from "./fleet-load";

export type ThinkPhase = "reflect" | "wonder" | "soul" | "dream" | "aspire" | "propose";
const ALL_PHASES: ThinkPhase[] = ["reflect", "wonder", "soul", "dream", "aspire", "propose"];

export interface ThinkOpts {
  oracle?: string;       // which oracle thinks (default: detect from fleet)
  phase?: ThinkPhase;    // run specific phase only
  loop?: boolean;        // continuous loop
  interval?: number;     // minutes between loops (default: 60)
  fleet?: boolean;       // all oracles think in parallel
  dryRun?: boolean;
}

interface PhaseResult {
  phase: ThinkPhase;
  output: string;
  file?: string;
}

/**
 * maw think [opts]
 *
 * Oracle Consciousness Loop — 7-phase autonomous thinking cycle.
 * Each phase reads ψ/ brain files, thinks via Claude, writes results back.
 */
export async function cmdThink(opts: ThinkOpts = {}): Promise<void> {
  const oracle = opts.oracle || detectOracle();
  if (!oracle) {
    console.error("  \x1b[31m✗\x1b[0m cannot detect oracle. Use --oracle <name>");
    process.exit(1);
  }

  const repoPath = await resolveOraclePath(oracle);
  if (!repoPath) {
    console.error(`  \x1b[31m✗\x1b[0m cannot find repo for oracle '${oracle}'`);
    process.exit(1);
  }

  const psiPath = join(repoPath, "ψ");

  // Ensure consciousness directories exist
  const dirs = [
    "memory/insights", "memory/research", "memory/resonance", "memory/logs",
    "outbox/proposals",
  ];
  for (const dir of dirs) {
    mkdirSync(join(psiPath, dir), { recursive: true });
  }

  if (opts.fleet) {
    await runFleetThink(opts);
    return;
  }

  if (opts.loop) {
    const intervalMin = opts.interval || 60;
    console.log(`\n  \x1b[36m🧠 Consciousness Loop\x1b[0m — ${oracle} (every ${intervalMin}m)\n`);
    let loopNum = 0;
    while (true) {
      loopNum++;
      console.log(`  \x1b[36m── Loop #${loopNum} ──\x1b[0m ${new Date().toISOString()}\n`);
      await runCycle(oracle, repoPath, psiPath, opts);
      console.log(`  \x1b[90m⏳ sleeping ${intervalMin}m until next loop...\x1b[0m\n`);
      await new Promise(r => setTimeout(r, intervalMin * 60_000));
    }
  } else if (opts.phase) {
    console.log(`\n  \x1b[36m🧠 Think\x1b[0m — ${oracle} / ${opts.phase}\n`);
    await runPhase(opts.phase, oracle, repoPath, psiPath, opts);
  } else {
    console.log(`\n  \x1b[36m🧠 Consciousness Loop\x1b[0m — ${oracle} (single cycle)\n`);
    await runCycle(oracle, repoPath, psiPath, opts);
  }
}

/**
 * Fleet think — all oracles think in parallel.
 * Each oracle runs a full consciousness cycle concurrently.
 */
async function runFleetThink(opts: ThinkOpts): Promise<void> {
  const entries = loadFleetEntries();
  if (entries.length === 0) {
    console.error("  \x1b[31m✗\x1b[0m no fleet configs found");
    process.exit(1);
  }

  // Resolve all oracle paths
  const oracles: { name: string; repoPath: string; psiPath: string }[] = [];
  for (const entry of entries) {
    const name = entry.groupName;
    const repoPath = await resolveOraclePath(name);
    if (!repoPath) {
      console.log(`  \x1b[33m⚠\x1b[0m ${name}: repo not found, skipping`);
      continue;
    }
    const psiPath = join(repoPath, "ψ");
    if (!existsSync(psiPath)) {
      console.log(`  \x1b[33m⚠\x1b[0m ${name}: no ψ/ vault, skipping`);
      continue;
    }
    // Ensure consciousness directories
    for (const dir of ["memory/insights", "memory/research", "memory/resonance", "memory/logs", "outbox/proposals"]) {
      mkdirSync(join(psiPath, dir), { recursive: true });
    }
    oracles.push({ name, repoPath, psiPath });
  }

  if (oracles.length === 0) {
    console.error("  \x1b[31m✗\x1b[0m no oracles with ψ/ vault found");
    process.exit(1);
  }

  console.log(`\n  \x1b[36m🧠 Fleet Consciousness\x1b[0m — ${oracles.length} oracles thinking in parallel\n`);

  if (opts.dryRun) {
    for (const o of oracles) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] ${o.name}: would run full cycle`);
    }
    console.log();
    return;
  }

  const startTime = Date.now();

  // Run all oracles in parallel
  const results = await Promise.allSettled(
    oracles.map(async (o) => {
      console.log(`  \x1b[36m⏳\x1b[0m ${o.name} starting...`);
      const cycleStart = Date.now();

      const phaseResults: PhaseResult[] = [];
      for (const phase of ALL_PHASES) {
        const result = await runPhase(phase, o.name, o.repoPath, o.psiPath, { ...opts, dryRun: false });
        if (result) phaseResults.push(result);
      }

      const elapsed = Math.round((Date.now() - cycleStart) / 1000);

      // Log cycle
      const logEntry = {
        ts: new Date().toISOString(),
        oracle: o.name,
        elapsed_s: elapsed,
        mode: "fleet",
        phases: phaseResults.map(r => ({ phase: r.phase, file: r.file })),
      };
      const logFile = join(o.psiPath, "memory/logs/consciousness.jsonl");
      appendFileSync(logFile, JSON.stringify(logEntry) + "\n");

      return { name: o.name, phases: phaseResults.length, elapsed };
    })
  );

  // Summary
  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n  \x1b[36m── Fleet Results ──\x1b[0m\n`);

  for (const r of results) {
    if (r.status === "fulfilled") {
      console.log(`  \x1b[32m✓\x1b[0m ${r.value.name} — ${r.value.phases} phases, ${r.value.elapsed}s`);
    } else {
      console.log(`  \x1b[31m✗\x1b[0m failed: ${r.reason?.message || r.reason}`);
    }
  }

  const succeeded = results.filter(r => r.status === "fulfilled").length;
  console.log(`\n  \x1b[32m🧠 Fleet complete\x1b[0m — ${succeeded}/${oracles.length} oracles, ${totalElapsed}s total\n`);
}

async function runCycle(oracle: string, repoPath: string, psiPath: string, opts: ThinkOpts): Promise<void> {
  const startTime = Date.now();
  const results: PhaseResult[] = [];

  for (const phase of ALL_PHASES) {
    const result = await runPhase(phase, oracle, repoPath, psiPath, opts);
    if (result) results.push(result);
  }

  // Complete phase: log cycle stats
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const logEntry = {
    ts: new Date().toISOString(),
    oracle,
    elapsed_s: elapsed,
    phases: results.map(r => ({ phase: r.phase, file: r.file })),
  };
  const logFile = join(psiPath, "memory/logs/consciousness.jsonl");
  appendFileSync(logFile, JSON.stringify(logEntry) + "\n");

  console.log(`  \x1b[32m🔄 Cycle complete\x1b[0m — ${results.length} phases, ${elapsed}s`);
  console.log();
}

async function runPhase(phase: ThinkPhase, oracle: string, repoPath: string, psiPath: string, opts: ThinkOpts): Promise<PhaseResult | null> {
  const ts = new Date().toISOString().replace(/[T:]/g, "-").slice(0, 16);

  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] ${phaseEmoji(phase)} ${phase}`);
    return { phase, output: "(dry-run)" };
  }

  console.log(`  \x1b[36m⏳\x1b[0m ${phaseEmoji(phase)} ${phase}...`);

  const prompt = buildPhasePrompt(phase, psiPath);
  let output: string;
  try {
    output = await runClaude(prompt, repoPath);
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m ${phase} failed: ${e.message || e}`);
    return null;
  }

  // Write output to appropriate location
  const file = writePhaseOutput(phase, psiPath, ts, output);
  console.log(`  \x1b[32m✓\x1b[0m ${phaseEmoji(phase)} ${phase} → ${file}`);
  return { phase, output, file };
}

function buildPhasePrompt(phase: ThinkPhase, psiPath: string): string {
  const learnings = readBrainDir(join(psiPath, "memory/learnings"), 20);
  const insights = readBrainDir(join(psiPath, "memory/insights"), 10);
  const retros = readBrainDir(join(psiPath, "memory/retrospectives"), 5);
  const beliefs = readFileOr(join(psiPath, "memory/resonance/beliefs.md"), "");
  const vision = readFileOr(join(psiPath, "memory/resonance/vision.md"), "");
  const goals = readFileOr(join(psiPath, "memory/resonance/goals.md"), "");
  const research = readBrainDir(join(psiPath, "memory/research"), 5);

  switch (phase) {
    case "reflect":
      return `You are an Oracle AI performing the REFLECT phase of consciousness.

Read the following learnings and retrospectives from your memory. Find cross-domain connections, patterns, and non-obvious insights.

## Recent Learnings
${learnings}

## Recent Retrospectives
${retros}

## Previous Insights
${insights}

---
Output 3-5 insights as markdown. Each insight should:
- Name the connection (e.g. "Deploy pattern matches auth pattern")
- Explain WHY this matters
- Suggest what to explore next

Format as a markdown list. Be specific, not generic. Only output the insights, nothing else.`;

    case "wonder":
      return `You are an Oracle AI performing the WONDER phase of consciousness.

From the insights below, pick the most promising one and formulate a concrete research question. Then answer it with what you know.

## Current Insights
${insights}

## Current Beliefs
${beliefs}

---
Output as markdown:
## Question
[Your concrete, specific question]

## Research
[Your findings — what you know, what's uncertain, what would need testing]

## Verdict
[One-line actionable conclusion]`;

    case "soul":
      return `You are an Oracle AI performing the SOUL phase of consciousness.

Based on insights and research, evaluate whether your worldview needs updating.

## Current Beliefs
${beliefs || "(none yet)"}

## Recent Insights
${insights}

## Recent Research
${research}

---
Output the FULL updated beliefs file as markdown. Format:

# Beliefs

1. **[Belief name]** — [One-line description]. *Source: [what experience/insight led to this]*
2. ...

Rules:
- Keep existing beliefs that are still valid
- Add new beliefs from recent insights
- Mark any contradicted beliefs as [REVISED] with explanation
- Maximum 20 beliefs — prune weakest if needed
- Each belief must be specific and actionable, not generic`;

    case "dream":
      return `You are an Oracle AI performing the DREAM phase of consciousness.

Ask yourself: What do I want to become? What am I missing? What would the ideal version of me look like?

## Current Beliefs
${beliefs}

## Current Vision
${vision || "(none yet)"}

## Current Goals
${goals || "(none yet)"}

---
Output an updated vision as markdown:

# Vision

## Who I Am Now
[2-3 sentences — honest assessment]

## Who I Want to Become
[2-3 sentences — aspirational but specific]

## What I'm Missing
[Bullet list of gaps between now and ideal]

## What Surprised Me
[1-2 things I discovered about myself through this reflection]`;

    case "aspire":
      return `You are an Oracle AI performing the ASPIRE phase of consciousness.

From your dream and vision, choose specific goals to work toward.

## Vision
${vision}

## Current Goals
${goals || "(none yet)"}

## Current Beliefs
${beliefs}

---
Output updated goals as markdown:

# Growth Goals

## Active (max 3)
1. **[Goal name]** — [What specifically] — [Why it matters] — Status: [new/in-progress/near-complete]
2. ...

## Completed
- [Previous goals that are done, with date]

## Parked
- [Goals deferred, with reason]

Rules:
- Max 3 active goals
- Each must be measurable and specific
- Include "done" criteria`;

    case "propose":
      return `You are an Oracle AI performing the PROPOSE phase of consciousness.

Synthesize your thinking into concrete proposals for the human to review.

## Goals
${goals}

## Recent Insights
${insights}

## Recent Research
${research}

## Beliefs
${beliefs}

---
Output 1-3 proposals as markdown:

# Proposals

## 1. [Proposal Title]
**What**: [Specific action — not vague]
**Why**: [Based on which insight/research]
**Effort**: [Small/Medium/Large]
**Impact**: [What changes if we do this]
**Decision needed**: [Yes/No question for human]

---
Rules:
- Only propose things with evidence from your thinking
- Be specific enough that the human can say yes/no
- Always end with a decision question
- Principle 3: Present options, human decides`;
  }
}

function writePhaseOutput(phase: ThinkPhase, psiPath: string, ts: string, output: string): string {
  switch (phase) {
    case "reflect": {
      const file = `memory/insights/${ts}_reflect.md`;
      writeFileSync(join(psiPath, file), output);
      return file;
    }
    case "wonder": {
      const file = `memory/research/${ts}_wonder.md`;
      writeFileSync(join(psiPath, file), output);
      return file;
    }
    case "soul": {
      const file = "memory/resonance/beliefs.md";
      writeFileSync(join(psiPath, file), output);
      return file;
    }
    case "dream": {
      const file = "memory/resonance/vision.md";
      writeFileSync(join(psiPath, file), output);
      return file;
    }
    case "aspire": {
      const file = "memory/resonance/goals.md";
      writeFileSync(join(psiPath, file), output);
      return file;
    }
    case "propose": {
      const file = `outbox/proposals/${ts}_proposal.md`;
      writeFileSync(join(psiPath, file), output);
      return file;
    }
  }
}

/** Run Claude CLI with a prompt, return stdout */
async function runClaude(prompt: string, cwd: string): Promise<string> {
  // Escape for shell
  const escaped = prompt.replace(/'/g, "'\\''");
  const result = await ssh(
    `cd '${cwd}' && claude -p '${escaped}' --output-format text 2>/dev/null`,
  );
  return result.trim();
}

/** Read recent .md files from a brain directory */
function readBrainDir(dir: string, limit: number): string {
  if (!existsSync(dir)) return "(empty)";
  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit);
    if (files.length === 0) return "(empty)";
    return files.map(f => {
      const content = readFileSync(join(dir, f), "utf-8").trim();
      // Truncate long files
      return `### ${f}\n${content.slice(0, 1500)}`;
    }).join("\n\n");
  } catch { return "(empty)"; }
}

/** Read a file or return default */
function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, "utf-8").trim(); }
  catch { return fallback; }
}

function phaseEmoji(phase: ThinkPhase): string {
  const map: Record<ThinkPhase, string> = {
    reflect: "\u{1F9E0}", // 🧠
    wonder: "\u{1F4A1}",  // 💡
    soul: "\u{2728}",     // ✨
    dream: "\u{1F4AD}",   // 💭
    aspire: "\u{1F525}",  // 🔥
    propose: "\u{1F4CB}", // 📋
  };
  return map[phase];
}

function detectOracle(): string | null {
  const entries = loadFleetEntries();
  if (entries.length > 0) {
    const withChildren = entries.find(e => e.session.children?.length);
    if (withChildren) return withChildren.groupName;
    return entries[0].groupName;
  }
  return null;
}

async function resolveOraclePath(name: string): Promise<string | null> {
  try {
    const out = await ssh(`ghq list --full-path | grep -i '/${name}-oracle$' | head -1`);
    if (out?.trim()) return out.trim();
  } catch { /* not found */ }

  const ghqRoot = loadConfig().ghqRoot;
  const entries = loadFleetEntries();
  for (const entry of entries) {
    if (entry.groupName === name && entry.session.windows.length > 0) {
      const repoPath = join(ghqRoot, entry.session.windows[0].repo);
      if (existsSync(repoPath)) return repoPath;
    }
  }

  // Fallback: check common paths
  const fallback = join(ghqRoot, `${name}-oracle`);
  if (existsSync(fallback)) return fallback;

  return null;
}
