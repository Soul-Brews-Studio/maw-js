# 2026-04-19 — Shape A Mega-Session Retrospective

> A one-day sprint that cut 5 alpha releases, merged ~50 PRs, shipped the plugin
> marketplace end-to-end, closed the #474 CodeQL bucket, and dogfooded a freshly
> budded oracle against its own parent. Written for future Claude.

## Shape of the day

- **4 rounds × 5 agents per round**, plus a mesh-child dogfood from a freshly
  budded `mawjs-plugin-oracle` invoking back into maw-js via `@peer` install.
- **5 alpha releases cut**: `.23 → .24 → .25 → .26 → .27 → .28`.
- **~50 PRs merged** from `b15e60f` (alpha.23 bump) through this PR (alpha.28).
- **5 new epics filed** from the work surfaced during the day:
  - `#627` oracle-team
  - `#640` lean-core
  - `#642` scoped routing
  - `#643` nickname stack (Phases 1–3 already shipped same day)
  - `#644` AirDrop / consent stack (Phases 1–3 already shipped same day)
  - `#655` fedtest harness (Phase 1 shipped)

## Major ships (what actually landed)

### Shape A — plugin marketplace, end-to-end
- `search-peers` federated search (#631, `b33450a`).
- `@peer/plugin` install syntax (#658, `5497f47`).
- Auto-link `maw-js` when installing `--link` plugins (#641, `fcd4920`).
- `/info` self-describing contract — schema + capabilities (#628 enrichment,
  `7abb30a`); surfaced in peer display (#643 Phase 2, `a9fec11`).
- End-to-end demo doc covering search → install → consent → trust (#660,
  `86b6f41`).
- Cross-oracle dogfood protocol doc (#634, `b3be005`).
- Adversarial peer-manifest harness (#633, `a52afd6`).

### Plugin portability / bud (#402, #588)
- `bud --from-repo` — scaffold (#591) → local full run (#595) → URL mode + `--pr`
  flag (#606) → `--force`, `--track-vault`, fleet entry, `--from` lineage (#611)
  → `--seed` + `--sync-peers` completes #588 (#620, `b0c601b`).
- `bud --nickname` sets pretty name at birth (#643 Phase 3, `f03f26c`).
- Fixes: use `ghq` root for post-clone scaffolding (#630, `4a1fbdf`); fix
  `js/indirect-command-line-injection` in `from-repo-fleet.ts` (#474, #618).

### Consent / AirDrop stack (#644)
- Phase 1 — PIN-consent primitive for `maw hey` (#657, `2aa35ef`).
- Phase 3 — gate `@peer` plugin install behind PIN (#662, `9f80b1b`).
- Phase 2 (wire PIN consent into team-invite) — still in flight at cap.

### Docker federation harness
- Dockerfile + `.dockerignore` for `maw-js:test` image (#597).
- compose.yml + dev helper for 2-node federation test (#598).
- Idempotent peer-bootstrap entrypoint (#600).
- 2-node probe round-trip integration script (#601).
- CI workflow + docs for federation integration (#599, `bc5cabe`).
- Topology diagram in `docker-testing.md` (#612, `05fe875`).
- Verified live end-to-end after #619 (#621, `ee935fa`).
- Fix: `serve` binds `0.0.0.0` on `MAW_HOST` env or `peers.json` presence
  (#616, `76e1db1`).
- Fix: align bun version with lockfile in the image (#607, `a415dfb`).
- Local 2-port `/info` + probe round-trip integration test (#3, `89728fb`).

### Nickname stack (#643)
- Phase 1 — oracle nickname field (#647, `22f4956`).
- Phase 2 — nickname in `/info` + peer display (#656, `a9fec11`).
- Phase 3 — `bud --nickname` (#663, `f03f26c`).

### `/info` endpoint + federation contract
- Transport `/info` endpoint for peer handshake (#596, `09ee0b9`).
- Self-describing contract enrichment (#628, `7abb30a`).

### #474 CodeQL bucket — closed
- `js/file-access-to-http × 4` audit (`3f10766`).
- `js/http-to-file-access × 4` audit (`db7c635`).
- `js/indirect-command-line-injection` in `from-repo-fleet.ts` (#618).
- `execFileSync + argv` for tmux/ssh attach in `view` (`146ae7d`).
- Prototype-pollution guard on `ev.oracle` in `demo/agents.html` (`420db66`).
- Stance doc + lgtm suppressions for 11 private-path file-system-race sites
  (#592).
- fd-based lock ops in `peers/lock` + instance-pid (`985ac4e`).
- lgtm doesn't close — replaced with Code Scanning dismissal (`a0d40d7`).

### fedtest harness (#655)
- Phase 1 — backends + canary scenario (#661, `b484e13`).
- Phase 2 (scenarios 02–05) — still in flight at cap.

### SDK surface (#626)
- Expanded exports — `cmdBud` + `cmdOracle*` + `getTransportRouter`
  (`b4eba47`).

### Peers ergonomics / correctness
- Fail loud on handshake failure — exit non-zero; `--allow-unreachable`
  opt-out (#636, `1c43d1a`).
- `HTTP_4XX` hint names stale-peer case (Task #7, `6240bda`).
- Classify `ENOTIMP` / `EAI_*` as DNS-family (`5541af7`).
- Loud handshake errors — DNS / refused / timeout / HTTP (#565, `ab816c2`).

## Mesh-convergence proof points

The mesh-child dogfood loop actually closed today:

- `mawjs-plugin-oracle` was budded from maw-js as a fresh oracle during the
  session.
- The child oracle invoked back into maw-js via `@peer` install syntax
  (`5497f47`) — the same code path we'd just shipped.
- This exercised the nickname → `/info` → peer display chain (#643 Phases
  1–3) and the consent primitive (#644 Phase 1) end-to-end, without
  coordination between the two oracles' instances. Independent execution of
  the same protocol on both sides is the strongest convergence signal we've
  seen on Shape A.

See also the validated mesh-convergence memory
`project_mesh_convergence_parseflags.md` — same pattern, different layer.

## Lessons learned (future-Claude: read these first)

### 1. `lgtm` doesn't close CodeQL findings
PR comments saying `// lgtm[<rule>]` don't move alerts to "closed" in the
GitHub Code Scanning UI. They silence the specific line locally, but the
alert stays open until you **dismiss it through the Code Scanning UI** (or the
`gh api` equivalent). Captured in `a0d40d7` and memory
`reference_codeql_local_pack_constraint.md`. Next time, dismiss first and
cite the dismissal; don't just sprinkle `lgtm` and call the ticket done.

### 2. `bud --from-repo` regression class: `/tmp/nope`
Early iterations of `--from-repo` resolved the clone destination from a
post-clone scaffolding path under `/tmp/nope/...` because `ghq` root hadn't
been established. Bud looked successful but the repo landed in the wrong
place; follow-up commands then failed with cryptic "no such repo". Fixed in
`4a1fbdf` (#630). Lesson: for any scaffolder that calls out to a package
manager, **resolve destination roots from the tool's own config before
writing**, never from the current working dir or an assumed `/tmp`.

### 3. PM2 staleness silently serves old code
During federation harness work, a PM2-managed serve kept answering on the
expected port but served the previous binary. Tests passed because `/info`
returned *valid* JSON — just from the old schema. The contract tests in
#89728fb now exercise the live round-trip, not just the handler in-process.
Lesson: **when a daemon is in the loop, assume staleness until the process
has been restarted in the current test run**. Kill-and-restart in the test
harness fixture, not between tests.

### 4. Docker workspace `COPY` order matters for bun
The image originally `COPY . .` then `bun install`, which re-hashed every
workspace on every code change and blew cache hit rate to ~0 per PR. Split
into `COPY package.json bun.lock ./` → `bun install` → `COPY . .`. Also:
`align bun version with lockfile` (#607, `a415dfb`) — the lockfile version
must match the image's bun or install silently "succeeds" while skipping
workspaces. Running `bun --version` as the first RUN in a broken image would
have saved ~3 debug cycles.

### 5. `bun` workspace install vs `npm i`
`bun install` in a monorepo uses the root lockfile; running it from a
workspace sub-dir is valid but will still modify the root lockfile. Never run
`bun install` from an agent worktree without first confirming you want the
root lockfile edited — multiple agents in parallel doing this produced
conflicting lockfile diffs mid-round. Rule: **install only from the repo
root, never from an agent/** worktree**; the worktree inherits node_modules
through bun's hoisting.

### 6. Lead-verified ground truth on release cut
The `feedback_lead_verify_canonical_tests` and `feedback_stash_pop_ground_truth`
memories held up again: agent "all green" was a hypothesis 3 times today;
lead's `bun run test:all` (after stash-reset-test-pop) was the evidence. The
tag does not move until lead verifies from a clean tree.

### 7. Mesh-child dogfood is the real acceptance test
Unit tests + integration tests both passed on Shape A before we budded
`mawjs-plugin-oracle`. The bud itself found 3 regressions in under 10 minutes
(`#630` bud path, `#607` docker bun version, `#641` auto-link). Lesson:
**"can a fresh child oracle actually use this?" is cheaper than one more test
suite layer**. Bud early, bud often.

## What's still in flight at cap

These tasks were parallel lanes with #5; lead picks up whichever didn't
land before the cap:

- **Task #1** — fedtest Phase 2 (scenarios 02–05: search-happy, offline,
  timeout, @peer install).
- **Task #2** — #644 Phase 2 (wire PIN consent into team-invite).
- **Task #3** — #651 adversarial follow-up (node identity cross-check).
- **Task #4** — #649 costs.test.ts `global.fetch` leak fix.

## Numbers

| Metric | Value |
|---|---|
| Alpha releases cut | 5 (`.23 → .28`) |
| Commits on main since `.23` | 50 |
| New epics filed | 5 (#627, #640, #642, #643, #644, #655) |
| Rounds × agents | 4 × 5 + 1 mesh-child |
| CodeQL bucket closed | #474 |
| Oracles budded mid-session | 1 (`mawjs-plugin-oracle`) |

## How to read this doc later

If you are future Claude waking into this repo:

1. **Start with "Lessons learned"** — each item is a trap that already
   burned time today. They will burn time again if you don't read them.
2. **Cross-reference the memories** — this doc names the right memory
   files where the long-form rule lives. The doc is the index; the memory
   is the load-bearing rule.
3. **Treat the "still in flight" list as authoritative for 2026-04-19
   state only.** By the time you read this, those tasks either landed or
   were re-filed under new numbers — check `git log` against the issue
   numbers before assuming state.

— `alpha28-and-retro`, capping team `go-5-r10-0419`
