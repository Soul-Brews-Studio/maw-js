import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { fleetLoadDirForWrite, loadFleetEntries } from "maw-js/sdk";
import { ensureStatusReporterScript, ensureMawMcpNudgeScript } from "../../../core/status-reporter";

/** Step 2: Create ψ/ vault directory structure. Returns the psiDir path. */
export function initVault(budRepoPath: string): string {
  const psiDir = join(budRepoPath, "ψ");
  const psiDirs = [
    "memory/learnings", "memory/retrospectives", "memory/traces",
    "memory/resonance", "memory/collaborations", "inbox", "outbox", "plans",
  ];
  for (const d of psiDirs) {
    mkdirSync(join(psiDir, d), { recursive: true });
  }
  console.log(`  \x1b[32m✓\x1b[0m ψ/ vault initialized`);
  return psiDir;
}

/** Step 3: Generate CLAUDE.md stub with identity + Rule 6 template. */
export function generateClaudeMd(budRepoPath: string, name: string, parentName: string | null): void {
  const claudeMd = join(budRepoPath, "CLAUDE.md");
  if (existsSync(claudeMd)) return;
  const now = new Date().toISOString().slice(0, 10);
  const lineageHeader = parentName
    ? `> Budded from **${parentName}** on ${now}`
    : `> Root oracle — born ${now} (no parent lineage)`;
  const lineageField = parentName
    ? `- **Budded from**: ${parentName}`
    : `- **Origin**: root (no parent)`;
  // lgtm[js/file-system-race] — PRIVATE-PATH: scaffold dest is user-owned, see docs/security/file-system-race-stance.md
  writeFileSync(claudeMd, `# ${name}-oracle

${lineageHeader}

## Identity
- **Name**: ${name}
- **Purpose**: (to be defined by /awaken)
${lineageField}
- **Federation tag**: \`[<host>:${name}]\` — replace \`<host>\` with your runtime host
  (e.g. \`mba\`, \`oracle-world\`, \`white\`, \`clinic-nat\`) when signing federation messages

## Principles (inherited from Oracle)
1. Nothing is Deleted
2. Patterns Over Intentions
3. External Brain, Not Command
4. Curiosity Creates Existence
5. Form and Formless

## Rule 6: Oracle Never Pretends to Be Human

The convention has THREE complementary signature contexts. Use the right one for the audience:

### 1. Internal federation messages (\`maw hey\`, \`maw broadcast\`)

Form: \`[<host>:${name}]\` — for example \`[mba:${name}]\` or \`[oracle-world:${name}]\`

- ALWAYS use the host:agent form, NEVER bare \`[${name}]\`
- The host context disambiguates when the same oracle name has multiple bodies on different hosts
- Established 2026-04-07 (Phase 5 of the convention)

### 2. Public-facing artifacts (GitHub issues/PRs, forums, blog comments, Slack)

Form: \`🤖 ตอบโดย ${name} จาก [Human] → ${name}-oracle\`

- "ตอบโดย" = "answered by", "จาก" = "from"
- The 🤖 emoji + Oracle name + Human creator + source repo
- Established 2026-01-25 (Phase 2 of the convention)
- Thai principle: *"กระจกไม่แกล้งเป็นคน"* — a mirror doesn't pretend to be a person

### 3. Git commit trailers

Form: \`Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\`

- Standard Anthropic attribution
- Add to the commit trailer when ${name} authors the commit

## Inbox Discipline

- Check pending messages with \`maw inbox\` or \`maw inbox status\` before long work.
- After acting on a \`ψ/inbox\` message, run \`maw inbox read <id>\` so consumed work stops counting as unread.
- Leave messages unread only while they still need attention from this oracle.

## Request-Reply Protocol

When you receive a message starting with \`[request:<correlationId>]\`:
1. Extract the correlationId (e.g. \`req-1-abc123-xyz\`)
2. Do the requested work
3. When done, reply with: \`maw reply <correlationId> "<your answer>"\`

To see pending requests awaiting your reply: \`maw reply --list\`

Run \`/awaken\` for the full identity setup ceremony.
`);
  console.log(`  \x1b[32m✓\x1b[0m CLAUDE.md generated`);
}

/** Step 3.5: Create .claude/settings.json with status-reporter hooks. */
export function generateClaudeSettings(budRepoPath: string): void {
  // The hooks below point at $HOME/.config/maw/hooks/status-reporter.sh — make
  // sure that script actually exists (it's wired but was never shipped).
  const reporter = ensureStatusReporterScript();
  if (reporter.created) console.log(`  \x1b[32m✓\x1b[0m status-reporter.sh installed`);

  // maw MCP nudge (mawjs-2) — universal PreToolUse(Bash) forcing function, shipped here
  // so a new bud inherits it at birth (worklog/company hooks stay company-provisioned via
  // setup-hooks — not inlined). The settings below reference it via literal $HOME.
  const nudge = ensureMawMcpNudgeScript();
  if (nudge.created) console.log(`  \x1b[32m✓\x1b[0m maw-mcp-nudge.sh installed`);

  const settingsDir = join(budRepoPath, ".claude");
  const settingsPath = join(settingsDir, "settings.json");
  if (existsSync(settingsPath)) {
    console.log(`  \x1b[90m○\x1b[0m .claude/settings.json exists`);
    return;
  }

  // Use a literal $HOME (expanded at runtime by the hook's shell) rather than the
  // bud-time absolute path. The settings.json is committed into the budded repo, so
  // baking the bud machine's HOME breaks the hook when the oracle runs elsewhere
  // (e.g. budded on a Mac → /Users/<x>/…, deployed on a Linux pod → /root/… not found).
  const hookScript = "$HOME/.config/maw/hooks/status-reporter.sh";
  const makeHook = (event: string) => ({
    matcher: "",
    hooks: [{ type: "command", command: `CLAUDE_HOOK_EVENT=${event} ${hookScript}` }],
  });

  const settings = {
    hooks: {
      SessionStart: [makeHook("SessionStart")],
      Stop: [makeHook("Stop")],
      // maw MCP nudge (mawjs-2) — deny bash `maw hey/reply/inbox/ls`, redirect to maw_* MCP.
      // Standalone script (no CLAUDE_HOOK_EVENT); literal $HOME for cross-machine portability.
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: "$HOME/.config/maw/hooks/maw-mcp-nudge.sh" }],
      }],
    },
  };

  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  \x1b[32m✓\x1b[0m .claude/settings.json + status hooks`);
}

/** Step 4: Create or update fleet config. Returns the fleet file path. */
export function configureFleet(name: string, org: string, budRepoName: string, parentName: string | null): string {
  // #202 — idempotent, always writes lineage
  const entries = loadFleetEntries();
  const existing = entries.find(e => e.session.name.replace(/^\d+-/, "") === name);
  let fleetFile: string;

  if (existing) {
    fleetFile = existing.path ?? join(fleetLoadDirForWrite(), existing.file);
    const cfg = JSON.parse(readFileSync(fleetFile, "utf-8"));
    let updated = false;
    if (!cfg.budded_from && parentName) { cfg.budded_from = parentName; updated = true; }
    if (!cfg.budded_at && parentName) { cfg.budded_at = new Date().toISOString(); updated = true; }
    if (updated) {
      writeFileSync(fleetFile, JSON.stringify(cfg, null, 2) + "\n");
      console.log(`  \x1b[32m✓\x1b[0m fleet config updated with lineage: ${fleetFile}`);
    } else {
      console.log(`  \x1b[90m○\x1b[0m fleet config exists: ${fleetFile}`);
    }
  } else {
    const maxNum = entries.reduce((max, e) => Math.max(max, e.num), 0);
    const budNum = maxNum + 1;
    const writeDir = fleetLoadDirForWrite();
    mkdirSync(writeDir, { recursive: true });
    fleetFile = join(writeDir, `${String(budNum).padStart(2, "0")}-${name}.json`);
    const fleetConfig: Record<string, unknown> = {
      name: `${String(budNum).padStart(2, "0")}-${name}`,
      windows: [{ name: `${name}-oracle`, repo: `${org}/${budRepoName}` }],
      sync_peers: parentName ? [parentName] : [],
    };
    if (parentName) {
      fleetConfig.budded_from = parentName;
      fleetConfig.budded_at = new Date().toISOString();
    }
    writeFileSync(fleetFile, JSON.stringify(fleetConfig, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m fleet config: ${fleetFile}`);
  }
  return fleetFile;
}

/** Step 4.5: Write birth note to ψ/memory/learnings/ if a note was provided. */
export function writeBirthNote(psiDir: string, name: string, parentName: string | null, note: string): void {
  const birthFrom = parentName ? `Budded from: ${parentName}` : "Root oracle — no parent";
  writeFileSync(
    join(psiDir, "memory", "learnings", `${new Date().toISOString().slice(0, 10)}_birth-note.md`),
    `---\npattern: Birth note${parentName ? ` from ${parentName}` : ""}\ndate: ${new Date().toISOString().slice(0, 10)}\nsource: maw bud\n---\n\n# Why ${name} was born\n\n${note}\n\n${birthFrom}\n`
  );
  console.log(`  \x1b[32m✓\x1b[0m birth note written`);
}
