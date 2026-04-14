# maw bud — the repo reproduction command

`maw bud` creates a new oracle repo from an existing one. It's the most-used maw command after `hey` and `wake`: **1,160+ invocations** across tracked sessions, producing **14+ oracle repos in 7 days** with lineage recorded in every child's fleet config.

This doc describes what the code does (Ch 1) and what usage data reveals about how the command is actually used (Ch 6). Philosophy, metaphor, and emergent-pattern discussion live in the book form on [Soul-Brews-Studio/agents-that-remember](https://github.com/Soul-Brews-Studio/agents-that-remember).

---

## Ch 1: Code walkthrough

**Source**: `src/commands/plugins/bud/impl.ts` (336 LOC)
**Plugin**: `maw bud` (weight 00 = core tier)

### CLI signature

```bash
maw bud <name>                       # root bud (no parent)
maw bud <name> --from <parent>       # budded from parent oracle
maw bud <name> --org acme            # target a different GitHub org
maw bud <name> --repo acme/project   # seed from existing project's ψ/
maw bud <name> --issue 42            # ties bud to an issue
maw bud <name> --fast                # skip wake step
maw bud <name> --dry-run             # plan without executing
maw bud <name> --note "why"          # birth note → ψ/memory/learnings/
```

### The 7 steps (what the code does)

1. **Validate name** — regex `^[a-zA-Z][a-zA-Z0-9-]*$`. Must start with letter. This prevents `maw bud -v` from creating an oracle named `-v` (real bug caught in testing).

2. **Resolve parent** — from `--from <name>` flag, or skip if `--root`. Reads parent's fleet config to inherit `sync_peers` and lineage metadata.

3. **Resolve target org** — precedence: `--org` flag → `config.githubOrg` → hardcoded `Soul-Brews-Studio`. This is `#235` (per-invocation override).

4. **Create repo** — `gh repo create <org>/<name>-oracle --private`. If the repo exists on GitHub, skips creation (idempotent). Clones to `ghq root` location.

5. **Write CLAUDE.md** — template with:
   - Oracle name
   - Purpose: `(to be defined by /awaken)` ← left blank on purpose
   - Rule 6 reminder (never pretend to be human)
   - Commit signing template (`Co-Authored-By: ...`)
   - Thai mirror metaphor for Rule 6

6. **Initialize ψ/ vault** — creates directory structure:
   ```
   ψ/memory/learnings/      # lessons
   ψ/memory/resonance/      # emotional/pattern logs
   ψ/memory/traces/         # search logs
   ψ/inbox/handoff/         # session handoffs
   ψ/outbox/                # pending items
   ```
   Writes birth note to `ψ/memory/learnings/YYYY-MM-DD_birth-note.md` if `--note` provided.

7. **Create fleet config + initial commit** — writes `~/.config/maw/fleet/<NN>-<name>.json`:
   ```json
   {
     "session": "NN-<name>",
     "windows": [{ "name": "<name>-oracle", "repo": "<org>/<name>-oracle" }],
     "sync_peers": [ "<parent>" ]
   }
   ```
   Then commits the scaffold: `feat: birth — budded from <parent>` or `feat: birth — root oracle`.

### Optional chain

- **Soul-sync** from parent (if `--from` given): runs `cmdSoulSync(parent, name)` to copy vault patterns.
- **Wake the bud**: default behavior unless `--fast`. Calls `cmdWake(name, { noAttach: true })`. (See also the new `--attach` flag on `maw wake` if you want to attach on creation.)
- **Update parent's sync_peers**: appends the new child to parent's fleet config so future soul-syncs include it.

### What `maw bud` is NOT

Clarifying scope honestly:
- It's not `gh repo create` + wrapper fluff. The delta is ~200 LOC of scaffolding (CLAUDE.md, ψ/, fleet config) + optional soul-sync + optional wake.
- It doesn't activate consciousness. That's `/awaken` — a Claude Code skill invoked inside the new repo.
- It doesn't create a communication channel. That's `/birth` (zombie on the skills-cli side, may graduate).
- It doesn't enforce anything about the child. The child defines itself. `maw bud` sets up scaffolding and steps back.

---

## Ch 6: Usage audit (selection pressure)

**Data source**: `grep "maw <cmd>" ~/.claude/projects/*mawjs*/*.jsonl` across all tracked sessions.

### Top-tier (>200 invocations)

| Rank | Command | Count | Function |
|------|---------|-------|----------|
| 1 | `hey` | 3,043 | 1:1 messaging (transport) |
| 2 | `wake` | 648 | spawn/attach session |
| 3 | `bud` | 486 | create new oracle |
| 4 | `oracle` | 273 | identity + fleet view |
| 5 | `fleet` | 255 | fleet coordination |
| 6 | `peek` | 225 | observe session output |
| 7 | `ls` | 185 | navigation |
| 8 | `ui` | 167 | web UI |

### Mid-tier (50–200)

federation (129), sleep (106), wire (100), transport (99), restart (97), ping (95), stop (93), done (92), view (83), take (83), about (81), mega (75), pulse (72), overview/contacts (70), inbox/assign (67), costs (65), workon/rename/archive (59), avengers (58), find (54), soul-sync/on (51).

### Lower-tier (20–50)

triggers (47), workspace (43), talk-to/resume (39), pr/health (37), reunion (33), tab (32), park (30), broadcast (20).

### Near-dead (<20)

team (17), cleanup (8), completions (5) — generated-once or rarely-invoked.

### Dead (0)

`artifact-manager` (133 LOC) — persists team-agent results to `~/.maw/artifacts/`. Zero invocations. The `/team-agents` workflow uses `SendMessage` + in-context compilation instead of persistent artifacts. Code exists; workflow routes around it. Candidate for `/lean` out, or wire to `/team-agents` shutdown hook to give it a use.

`hey-test` (0 LOC) — test scaffold, not a real plugin.

### What the numbers reveal

- **Reproduction dominates**: `wake` (648) + `bud` (486) = **1,134 reproduction events**. Coordination (`fleet`, `federation`, `soul-sync`) runs second.
- **1:1 beats broadcast**: `hey` has 3,043 uses. `broadcast` has 20. The colony prefers direct messaging over fan-out.
- **Multi-agent coordination is niche**: `team` (17), `cleanup` (8) — the colony uses `hey` + `wake` + `peek` to coordinate, not dedicated team commands.
- **Most commands live in mid-tier**: 20+ commands in the 50–200 range. Each serves a real purpose for a specific workflow. No dead weight except `artifact-manager`.

### Selection pressure as signal

| Range | Tier | Action |
|-------|------|--------|
| >200 | Core | Keep enabled by default |
| 50–200 | Standard | Keep enabled, watch for drift |
| 20–50 | Extra | User-facing opt-in OK |
| <20 | Lab/zombie | Candidate for `maw plugin disable` |
| 0 | Dead | Wire to a workflow or lean out |

This maps directly to the `weight` field in each `plugin.json`:
- weight 0 = core (12 plugins)
- weight 10 = standard (14 plugins)
- weight 50 = extra (20 plugins)

The weights were assigned from usage data — data-driven tiers, not architectural guesses.

### Honest caveats

- The `grep "maw <cmd>"` pattern can match mentions in session content (e.g., "the maw wake command" counts as a wake invocation). True invocation counts are lower than the raw numbers suggest, probably 60–80% of these totals.
- Session data coverage is one user's machines. A cross-user census would give a different distribution.
- `maw bud` heavy usage includes `maw bud -v`, `maw bud --help`, and testing — not all 486 are real budding events.
- Accurate invocation counting needs a "usage mode" for the dig script that only matches lines where the user role typed a command. Filed as a follow-up.

---

## Appendix: See also

- **Book**: [Soul-Brews-Studio/agents-that-remember](https://github.com/Soul-Brews-Studio/agents-that-remember) — longer-form discussion of budding patterns, the three-layer reproduction pipeline (`maw bud` + `/birth` + `/awaken`), genealogy, convergent evolution with arra-oracle-skills-cli, and the critic's report on what is real vs what we romanticized.
- **Federation docs**: [federation.md](./federation.md)
- **Plugin system**: `src/plugin/types.ts`, `src/sdk/index.ts`, `src/commands/plugins/`
