import { hostExec } from "../ssh";
import { loadConfig } from "../config";
import { loadFleetEntries } from "./fleet-load";
import { cmdSoulSync } from "./soul-sync";
import { cmdWake } from "./wake";
import { FLEET_DIR } from "../paths";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export interface BudOpts {
  from?: string;
  repo?: string;
  issue?: number;
  fast?: boolean;
  dryRun?: boolean;
  note?: string;
}

/**
 * maw bud <name> [--from <parent>] [--repo org/repo] [--issue N] [--fast] [--dry-run]
 *
 * Yeast budding — any oracle can spawn a new oracle.
 *
 * Steps:
 *   1. Create oracle repo (gh repo create)
 *   2. Initialize ψ/ vault
 *   3. Generate CLAUDE.md stub
 *   4. Create fleet config
 *   5. Soul-sync seed from parent
 *   6. Wake the bud
 *   7. Update parent's sync_peers
 */
export async function cmdBud(name: string, opts: BudOpts = {}) {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const org = config.githubOrg || "Soul-Brews-Studio";

  // Resolve parent oracle
  let parentName = opts.from;
  if (!parentName) {
    try {
      const cwd = (await hostExec("tmux display-message -p '#{pane_current_path}'")).trim();
      const repoName = cwd.split("/").pop() || "";
      parentName = repoName.replace(/-oracle$/, "").replace(/\.wt-.*$/, "");
    } catch {
      console.error("  \x1b[31m✗\x1b[0m could not detect parent oracle. Use --from <oracle>");
      process.exit(1);
    }
  }

  const budRepoName = `${name}-oracle`;
  const budRepoSlug = `${org}/${budRepoName}`;
  const budRepoPath = join(ghqRoot, "github.com", org, budRepoName);

  console.log(`\n  \x1b[36m🧬 Budding\x1b[0m — ${parentName} → ${name}\n`);

  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create repo: ${budRepoSlug}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would init ψ/ vault at: ${budRepoPath}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would generate CLAUDE.md`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create fleet config`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would soul-sync from ${parentName}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would wake ${name}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would add ${name} to ${parentName}'s sync_peers`);
    console.log();
    return;
  }

  // 1. Create oracle repo
  if (existsSync(budRepoPath)) {
    console.log(`  \x1b[90m○\x1b[0m repo already exists: ${budRepoPath}`);
  } else {
    console.log(`  \x1b[36m⏳\x1b[0m creating repo: ${budRepoSlug}...`);
    try {
      // Pre-check: if repo already exists on GitHub, skip creation
      const viewCheck = await hostExec(`gh repo view ${budRepoSlug} --json name 2>/dev/null`).catch(() => "");
      if (viewCheck.includes(budRepoName)) {
        console.log(`  \x1b[90m○\x1b[0m repo already exists on GitHub`);
      } else {
        await hostExec(`gh repo create ${budRepoSlug} --private --add-readme`);
        console.log(`  \x1b[32m✓\x1b[0m repo created on GitHub`);
      }
    } catch (e: any) {
      if (e.message?.includes("already exists")) {
        console.log(`  \x1b[90m○\x1b[0m repo already exists on GitHub`);
      } else if (e.message?.includes("403") || e.message?.includes("admin")) {
        console.error(`  \x1b[31m✗\x1b[0m no permission to create repos in ${org}`);
        console.error(`  \x1b[90m  ask an org admin to create ${budRepoSlug} first, then re-run maw bud\x1b[0m`);
        process.exit(1);
      } else {
        throw e;
      }
    }
    await hostExec(`ghq get -p github.com/${budRepoSlug}`);
    console.log(`  \x1b[32m✓\x1b[0m cloned via ghq`);
  }

  // 2. Initialize ψ/ vault
  const psiDir = join(budRepoPath, "ψ");
  const psiDirs = [
    "memory/learnings", "memory/retrospectives", "memory/traces",
    "memory/resonance", "inbox", "outbox", "plans",
  ];
  for (const d of psiDirs) {
    mkdirSync(join(psiDir, d), { recursive: true });
  }
  console.log(`  \x1b[32m✓\x1b[0m ψ/ vault initialized`);

  // 3. Generate CLAUDE.md stub
  const claudeMd = join(budRepoPath, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    const now = new Date().toISOString().slice(0, 10);
    writeFileSync(claudeMd, `# ${name}-oracle

> Budded from **${parentName}** on ${now}

## Identity
- **Name**: ${name}
- **Purpose**: (to be defined by /awaken)
- **Budded from**: ${parentName}

## Principles
Inherited from Oracle:
1. Nothing is Deleted
2. Patterns Over Intentions
3. External Brain, Not Command
4. Curiosity Creates Existence
5. Form and Formless

Rule 6: Oracle Never Pretends to Be Human
`);
    console.log(`  \x1b[32m✓\x1b[0m CLAUDE.md generated`);
  }

  // 4. Create fleet config
  const entries = loadFleetEntries();
  const maxNum = entries.reduce((max, e) => Math.max(max, e.num), 0);
  const budNum = maxNum + 1;
  const fleetFile = join(FLEET_DIR, `${String(budNum).padStart(2, "0")}-${name}.json`);

  if (!existsSync(fleetFile)) {
    const fleetConfig = {
      name: `${String(budNum).padStart(2, "0")}-${name}`,
      windows: [{ name: `${name}-oracle`, repo: `${org}/${budRepoName}` }],
      sync_peers: [parentName],
      budded_from: parentName,
      budded_at: new Date().toISOString(),
    };
    writeFileSync(fleetFile, JSON.stringify(fleetConfig, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m fleet config: ${fleetFile}`);
  }

  // 4.5. Write birth note if provided
  if (opts.note) {
    writeFileSync(join(psiDir, "memory", "learnings", `${new Date().toISOString().slice(0, 10)}_birth-note.md`),
      `---\npattern: Birth note from ${parentName}\ndate: ${new Date().toISOString().slice(0, 10)}\nsource: maw bud\n---\n\n# Why ${name} was born\n\n${opts.note}\n\nBudded from: ${parentName}\n`);
    console.log(`  \x1b[32m✓\x1b[0m birth note written`);
  }

  // 5. Soul-sync seed from parent
  console.log(`  \x1b[36m⏳\x1b[0m soul-sync seed from ${parentName}...`);
  try {
    await cmdSoulSync(parentName, { from: true, cwd: budRepoPath });
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m soul-sync seed failed (parent may have empty ψ/)`);
  }

  // 6. Initial git commit + push
  try {
    await hostExec(`git -C '${budRepoPath}' add -A`);
    await hostExec(`git -C '${budRepoPath}' commit -m 'feat: birth — budded from ${parentName}'`);
    await hostExec(`git -C '${budRepoPath}' push -u origin HEAD`);
    console.log(`  \x1b[32m✓\x1b[0m initial commit pushed`);
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m git push failed (may need manual setup)`);
  }

  // 7. Update parent's sync_peers
  for (const entry of loadFleetEntries()) {
    const entryName = entry.session.name.replace(/^\d+-/, "");
    if (entryName === parentName) {
      const parentFile = join(FLEET_DIR, entry.file);
      const parentConfig = JSON.parse(readFileSync(parentFile, "utf-8"));
      const peers: string[] = parentConfig.sync_peers || [];
      if (!peers.includes(name)) {
        peers.push(name);
        parentConfig.sync_peers = peers;
        writeFileSync(parentFile, JSON.stringify(parentConfig, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m added ${name} to ${parentName}'s sync_peers`);
      }
      break;
    }
  }

  // 8. Wake the bud
  console.log(`  \x1b[36m⏳\x1b[0m waking ${name}...`);
  const wakeOpts: any = { noAttach: true };
  if (opts.issue) {
    const { fetchIssuePrompt } = await import("./wake");
    wakeOpts.prompt = await fetchIssuePrompt(opts.issue, `${org}/${budRepoName}`);
    wakeOpts.task = `issue-${opts.issue}`;
  }
  if (opts.repo) {
    wakeOpts.incubate = opts.repo;
  }

  try {
    await cmdWake(name, wakeOpts);
    console.log(`  \x1b[32m✓\x1b[0m ${name} is alive`);
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m wake failed: ${e.message || e}`);
    console.log(`  \x1b[90m  try: maw wake ${name}\x1b[0m`);
  }

  // 8.5. Copy local project ψ/ if --repo was used and it exists
  if (opts.repo) {
    const localPsi = join(ghqRoot, "github.com", opts.repo, "ψ", "memory");
    if (existsSync(localPsi)) {
      const { syncDir } = await import("./soul-sync");
      for (const sub of ["learnings", "retrospectives", "traces"]) {
        const src = join(localPsi, sub);
        const dst = join(psiDir, "memory", sub);
        if (existsSync(src)) { try { syncDir(src, dst); } catch {} }
      }
      console.log(`  \x1b[32m✓\x1b[0m copied local project ψ/ from ${opts.repo}`);
    }
  }

  // Summary
  console.log(`\n  \x1b[32m🧬 Bud complete!\x1b[0m ${parentName} → ${name}`);
  console.log(`  \x1b[90m  repo: ${budRepoSlug}`);
  console.log(`  \x1b[90m  fleet: ${fleetFile}`);
  console.log(`  \x1b[90m  sync_peers: [${parentName}]`);
  if (!opts.fast) {
    console.log(`  \x1b[90m  run /awaken in the new oracle for full identity setup\x1b[0m`);
  }
  console.log();
}
