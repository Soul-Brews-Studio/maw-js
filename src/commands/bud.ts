import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { ssh } from "../ssh";
import { loadConfig } from "../config";
import { FLEET_DIR } from "../paths";
import { loadFleetEntries } from "./fleet-load";
import { cmdSoulSync } from "./soul-sync";
import { cmdWake } from "./wake";

export interface BudOpts {
  from?: string;       // explicit parent oracle name
  repo?: string;       // incubate external repo (org/repo)
  issue?: number;      // seed with GitHub issue
  fast?: boolean;      // skip /awaken ritual
  dryRun?: boolean;    // preview only
}

/**
 * maw bud <name> [opts]
 *
 * Spawn a new child oracle via the yeast budding model.
 * 8 steps: repo → vault → identity → fleet → family → soul-sync → wake → update parent
 */
export async function cmdBud(name: string, opts: BudOpts = {}): Promise<void> {
  const cfg = loadConfig();
  const ghqRoot = cfg.ghqRoot;

  // Detect parent oracle
  const parentName = opts.from || detectCurrentOracle();
  if (!parentName) {
    console.error("  \x1b[31m✗\x1b[0m cannot detect parent oracle. Use --from <oracle>");
    process.exit(1);
  }

  const repoName = `${name}-oracle`;
  const repoPath = join(ghqRoot, repoName);

  console.log(`\n  \x1b[36m🌱 Budding\x1b[0m — ${parentName} → ${name}\n`);

  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create repo: ${repoPath}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would init ψ/ vault`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would generate CLAUDE.md identity`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create fleet config`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would update parent '${parentName}' children[]`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would soul-sync seed from ${parentName}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would wake ${name}`);
    console.log();
    return;
  }

  // Step 1: Create oracle repo
  if (existsSync(repoPath)) {
    console.log(`  \x1b[33m⚠\x1b[0m repo already exists: ${repoPath}`);
  } else {
    mkdirSync(repoPath, { recursive: true });
    await ssh(`git -C '${repoPath}' init`);
    console.log(`  \x1b[32m✓\x1b[0m created repo: ${repoPath}`);
  }

  // Step 2: Initialize ψ/ vault
  const vaultDirs = [
    "ψ/inbox/handoff",
    "ψ/memory/learnings",
    "ψ/memory/retrospectives",
    "ψ/memory/traces",
    "ψ/memory/resonance",
    "ψ/writing",
    "ψ/lab",
    "ψ/archive",
    "ψ/outbox",
  ];
  for (const dir of vaultDirs) {
    const fullPath = join(repoPath, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      // Add .gitkeep so directories are tracked
      writeFileSync(join(fullPath, ".gitkeep"), "");
    }
  }
  console.log(`  \x1b[32m✓\x1b[0m initialized ψ/ vault`);

  // Step 3: Generate CLAUDE.md identity
  const claudeMdPath = join(repoPath, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    const now = new Date().toISOString().split("T")[0];
    const claudeMd = `# ${capitalize(name)} Oracle

## Identity

**I am**: ${capitalize(name)} Oracle
**Parent**: ${capitalize(parentName)} Oracle
**Born**: ${now}
**Budded from**: ${parentName}
**Mode**: Full Soul Sync

## Brain Structure

\`\`\`
ψ/
├── inbox/        # Communication — handoffs, schedule, focus
├── memory/       # Knowledge
│   ├── resonance/      # Soul, identity, principles
│   ├── learnings/      # Patterns discovered
│   ├── retrospectives/ # Session reflections
│   └── traces/         # Discovery traces
├── writing/      # Drafts
├── lab/          # Experiments
├── archive/      # Completed work
└── outbox/       # Messages to send
\`\`\`
`;
    writeFileSync(claudeMdPath, claudeMd);
    console.log(`  \x1b[32m✓\x1b[0m generated CLAUDE.md identity`);
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m CLAUDE.md already exists`);
  }

  // Initial commit
  try {
    await ssh(`git -C '${repoPath}' add -A && git -C '${repoPath}' commit -m 'init: ${name} oracle — budded from ${parentName}'`);
  } catch { /* may already have commits */ }

  // Step 4: Create fleet config
  const entries = loadFleetEntries();
  const usedNums = entries.map(e => e.num);
  let nextNum = 10; // start children at 10+
  while (usedNums.includes(nextNum)) nextNum++;
  const fleetNum = String(nextNum).padStart(2, "0");
  const fleetFile = join(FLEET_DIR, `${fleetNum}-${name}.json`);

  if (!existsSync(fleetFile)) {
    const fleetConfig = {
      name: `${fleetNum}-${name}`,
      windows: [{ name: `${name}-oracle`, repo: repoName }],
      parent: parentName,
      budded_from: parentName,
      budded_at: new Date().toISOString(),
    };
    writeFileSync(fleetFile, JSON.stringify(fleetConfig, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m fleet config: ${fleetNum}-${name}.json`);
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m fleet config already exists`);
  }

  // Step 5: Update parent's children[]
  updateParentChildren(parentName, name);
  console.log(`  \x1b[32m✓\x1b[0m updated ${parentName}'s children[]`);

  // Step 6: Soul-sync seed from parent
  try {
    const results = await cmdSoulSync(parentName);
    const total = results.reduce((a, r) => a + r.total, 0);
    if (total > 0) {
      console.log(`  \x1b[32m✓\x1b[0m soul-sync seeded ${total} file(s) from ${parentName}`);
    } else {
      console.log(`  \x1b[90m○\x1b[0m soul-sync: nothing to seed`);
    }
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m soul-sync seed failed (non-fatal)`);
  }

  // Step 7: Wake the bud
  const wakeOpts: any = {};
  if (opts.repo) wakeOpts.incubate = opts.repo;
  if (opts.issue) {
    const { fetchIssuePrompt } = await import("./wake-resolve");
    wakeOpts.prompt = await fetchIssuePrompt(opts.issue, opts.repo);
    wakeOpts.task = `issue-${opts.issue}`;
  }
  if (!opts.fast) {
    // Send /awaken as initial prompt
    wakeOpts.prompt = wakeOpts.prompt || "/awaken --fast";
  }

  await cmdWake(name, wakeOpts);
  console.log(`  \x1b[32m✓\x1b[0m woke ${name}`);

  // Summary
  console.log(`\n  \x1b[32m🌱 Bud complete!\x1b[0m ${parentName} → ${name}`);
  console.log(`  \x1b[90m  repo: ${repoPath}\x1b[0m`);
  console.log(`  \x1b[90m  fleet: ${fleetNum}-${name}.json\x1b[0m`);
  console.log(`  \x1b[90m  parent: ${parentName}\x1b[0m`);
  console.log();
}

/** Detect current oracle name from fleet config or cwd */
function detectCurrentOracle(): string | null {
  // Check fleet config for oracle with children (likely the parent)
  const entries = loadFleetEntries();
  if (entries.length > 0) {
    // Return the first oracle that has children or is num 01
    const withChildren = entries.find(e => e.session.children?.length);
    if (withChildren) return withChildren.groupName;
    return entries[0].groupName;
  }
  return null;
}

/** Add child to parent's children[] in fleet config */
function updateParentChildren(parentName: string, childName: string): void {
  const entries = loadFleetEntries();
  for (const entry of entries) {
    if (entry.groupName === parentName) {
      const filePath = join(FLEET_DIR, entry.file);
      const config = JSON.parse(readFileSync(filePath, "utf-8"));
      const children: string[] = config.children || [];
      if (!children.includes(childName)) {
        children.push(childName);
        config.children = children;
        writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
      }
      return;
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
