import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { SYNC_ITEMS, ensureSeatResumeHook, formatSyncResult, syncCrewSkills } from "../../src/vendor/mpr-plugins/crew-skills/sync.ts?plugin-crew-skills-standalone";

const pluginRoot = join(import.meta.dir, "../../src/vendor/mpr-plugins/crew-skills");
const assetsDir = join(pluginRoot, "assets");
const tmpRoots: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "crew-skills-home-"));
  tmpRoots.push(home);
  return home;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// kobo-573 — syncCrewSkills() defaults repoDir to process.cwd() (correct for a
// real user running from their own repo, per SyncOptions — NOT changing that
// default). Every syncCrewSkills() call in this file must instead pass an
// explicit repoDir pointing at a throwaway tmpdir, or it writes this actual
// checkout's real .claude/settings.json (kobo-573: a test run silently dirtied
// it, git-tracked, ~caught only by an incidental `git status`). This whole-file
// guard is the backstop: if a `repoDir` is ever dropped from a test above,
// THIS repo's real .claude/settings.json changes and the assertion below goes
// red — not a silent pass.
const cwdSettingsPath = join(process.cwd(), ".claude/settings.json");
let cwdSettingsBefore: string | null;
beforeAll(() => {
  cwdSettingsBefore = existsSync(cwdSettingsPath) ? readFileSync(cwdSettingsPath, "utf8") : null;
});
afterAll(() => {
  const after = existsSync(cwdSettingsPath) ? readFileSync(cwdSettingsPath, "utf8") : null;
  expect(after).toBe(cwdSettingsBefore); // this file's own repoDir cwd never gets touched
});

describe("crew-skills plugin standalone boundary", () => {
  test("sync keeps explicit standalone import boundaries (no deep maw-js coupling)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "crew-skills",
      allowRelative: ["./sync"],
    }).map((record) => record.spec);
    // sync.ts is pure node:fs — the whole point is zero core/config coupling.
    expect(imports).toContain("node:fs");
  });

  test("declares a passthrough cli command, no serve hook", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));
    expect(manifest.cli.command).toBe("crew-skills");
    expect(manifest.hooks).toBeUndefined();
  });
});

describe("crew-skills global asset contract", () => {
  // The worker spawn contract is deadlock-critical (kobo-91): a worker with no
  // Stop hook never signals idle. Global install only works if the settings +
  // hook are addressed by $HOME-absolute paths, not cwd-relative ones.
  test("worker settings points the Stop hook at a $HOME-absolute path", () => {
    const settings = readFileSync(join(assetsDir, "crew-worker-settings.json"), "utf8");
    expect(settings).toContain("$HOME/.claude/hooks/crew-worker-stop.sh");
    expect(settings).not.toContain('"bash .claude/hooks');
    // still valid JSON with a Stop hook
    const parsed = JSON.parse(settings);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("$HOME/.claude/hooks/crew-worker-stop.sh");
  });

  // kobo-196/268 — worker panes spawn with crew-worker-settings.json (not the repo's
  // settings), so the auto-seat SessionStart hook must ride this asset too to cover them
  // (scoped-both: repo settings → lead/comm/conductor, this → workers). kobo-268: the
  // matcher fires on startup|resume|clear (not clear-only) so a worker auto-seats on every
  // (re)start, not just after /clear.
  test("worker settings carries the SessionStart seat-resume hook (startup|resume|clear)", () => {
    const parsed = JSON.parse(readFileSync(join(assetsDir, "crew-worker-settings.json"), "utf8"));
    const entry = parsed.hooks.SessionStart.find((e: any) => e.matcher === "startup|resume|clear");
    expect(entry.hooks[0].command).toBe("bash $HOME/.claude/hooks/seat-resume.sh");
  });

  // kobo-268 — the seat-resume hook is a synced executable asset that resolves the resume
  // file from the crew env (CREW_STATE_DIR/CREW_ROLE, like the Stop hook) so it seats BOTH
  // crew (ψ/active/crew/worker.md) and warroom (ψ/active/warroom, lead-handoff.md) layouts.
  test("seat-resume hook is a synced executable + resolves crew env AND warroom fallback", () => {
    const item = SYNC_ITEMS.find((i) => i.dest === "hooks/seat-resume.sh");
    expect(item).toBeDefined();
    expect(item?.exec).toBe(true);
    const hook = readFileSync(join(assetsDir, "hooks/seat-resume.sh"), "utf8");
    expect(hook).toContain("CREW_STATE_DIR"); // env-first (mirrors the Stop hook)
    expect(hook).toContain("CREW_ROLE");
    expect(hook).toContain("@role"); // durable tmux fallback
    expect(hook).toContain("$STEM.md"); // crew's role-named file (worker.md)
    expect(hook).toContain("lead-handoff.md"); // eq3 fix + warroom special name
    expect(hook).toContain("ψ/active/crew"); // seats the crew layout too (patchwork dogfood)
    expect(hook).toContain("ψ/active/worker"); // kobo-316: worker fallback dir
    expect(hook).toContain("exit 0"); // solo-safe guards (no dir / no role → silent)
    // kobo-269 fix: when no CREW_STATE_DIR, search BOTH dirs and let the dir that HOLDS the
    // role file win — an empty leftover crew/ must not shadow a populated warroom/ (lead no-seat).
    expect(hook).toContain('for d in $DIRS'); // dir-selection loops both dirs, not blind-pick
    expect(hook).toContain("break 2"); // first dir with a matching file wins
    // kobo-268 fix: the case globs are case-sensitive, but labels are capitalized
    // ("🎼 Conductor") — the stem MUST be lowercased or Conductor never matches conduct*.
    expect(hook).toContain("tr '[:upper:]' '[:lower:]'");
    expect(hook).toContain("conduct*"); // the capitalized-label role this fix rescues
    // kobo-297 — auto-seat is observable: a visible boot-line right after `maw presence back`
    // confirms the pane re-seated online (the flip was otherwise a silent background write).
    expect(hook).toContain("presence: online (auto-seated)");
  });

  // kobo-174/200 — the lead card-gate hook ships as an executable global asset so an
  // oracle that opts in (via .maw/card-gate.json) points at a real script.
  test("card-gate hook is a synced executable asset", () => {
    const item = SYNC_ITEMS.find((i) => i.dest === "hooks/maw-card-gate.sh");
    expect(item).toBeDefined();
    expect(item?.exec).toBe(true);
    const hook = readFileSync(join(assetsDir, "hooks/maw-card-gate.sh"), "utf8");
    // gates BOTH paths (MCP-gap lesson) + fail-CLOSED + opt-in + conscious override
    expect(hook).toContain("mcp__maw__maw_task");
    expect(hook).toContain("maw task add");
    expect(hook).toContain(".maw/card-gate.json"); // kobo-200: CC-safe config source
    expect(hook).toContain(".mawCardGate");        // legacy settings.json fallback still read
    expect(hook).toContain("--force-lead");
    expect(hook).toContain('"deny"');
  });

  // kobo-200 — a dormant sample config ships so adopters can copy it to
  // <repo>/.maw/card-gate.json. It must install to ~/.claude (NOT .maw/) so the
  // hook never reads it → sync never auto-activates the gate for everyone.
  test("card-gate sample ships as a dormant asset (never the live .maw path)", () => {
    const item = SYNC_ITEMS.find((i) => i.dest === "card-gate.sample.json");
    expect(item).toBeDefined();
    expect(item?.dest).not.toContain(".maw"); // dormant — hook reads .maw/card-gate.json, not this
    const sample = JSON.parse(readFileSync(join(assetsDir, "card-gate.sample.json"), "utf8"));
    expect(sample.leadRole).toBe("lead");
    expect(sample.gatedTools).toContain("maw_task add");
  });

  test("crew skill spawns workers with the $HOME-absolute settings path", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(skill).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
    expect(skill).not.toContain("--settings .claude/crew-worker-settings.json");
  });

  // kobo-282 regress guard — the front @role tag has broken THREE times (270→271→281):
  // it must live in §0 init (fires on every /crew, incl a STANDBY front with 0 workers)
  // AND after the company-gate refuse (a refused /crew exits before it tags — no stale
  // coord). Pin both invariants by position so a future eye can't silently re-break it.
  test("front @role tag is baked at §0 init — after company-gate refuse, before §1 spawn (kobo-282)", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    const tagIdx = skill.indexOf('set-option -p -t "$TMUX_PANE" @role "🧭 coord"');
    const refuseIdx = skill.indexOf("crew ต้องอยู่ใน company"); // §0 company-gate refuse (exit)
    const spawnIdx = skill.indexOf("## 1. Spawn"); // worker-spawn section (§1 Layout was the old home)
    expect(tagIdx).toBeGreaterThan(-1);
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(-1);
    expect(tagIdx).toBeGreaterThan(refuseIdx); // refused /crew exits before tagging → no stale coord
    expect(tagIdx).toBeLessThan(spawnIdx); // unconditional at init, NOT deferred to worker-spawn (kobo-270 gap)
    // single source — the old §1 Layout copy (tagged $COORD) is gone
    expect(skill).not.toContain('set-option -p -t "$COORD" @role "🧭 coord"');
  });

  // kobo-303 — /warroom hard-removed; /head is the coord skill that spawns workers now.
  // Same global path requirement (kobo-94): a bare/relative --settings re-opens the
  // deadlock once local .claude/ copies are removed.
  test("head skill has no cwd-relative crew-worker-settings reference", () => {
    const skill = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    expect(skill).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
    expect(skill).not.toContain("--settings .claude/crew-worker-settings.json");
    // no bare relative "crew-worker-settings.json" (only the $HOME-absolute form)
    for (const m of skill.matchAll(/crew-worker-settings\.json/g)) {
      const before = skill.slice(Math.max(0, m.index! - 20), m.index!);
      expect(before).toContain("$HOME/.claude/");
    }
  });

  // kobo-95/303 — /head reviewer+scratchpad write to ψ/active/head/ — the hook state hint
  // must follow via CREW_STATE_DIR, or a coord that trusts the hint reads the wrong path.
  test("head spawn sets CREW_STATE_DIR and hook honors it", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    expect(head).toContain("CREW_STATE_DIR=ψ/active/head");

    const hook = readFileSync(join(assetsDir, "hooks/crew-worker-stop.sh"), "utf8");
    expect(hook).toContain("${CREW_STATE_DIR:-ψ/active/crew}/$CREW_ROLE.md");
    // no lingering hardcoded crew path in the hint
    expect(hook).not.toContain("state: ψ/active/crew/$CREW_ROLE.md");
  });

  // kobo-356: the Stop hook attaches the board-read next-ready queue to a WORKER's
  // idle ping (event-driven — no loop/poll) so the conductor dispatches immediately
  // instead of a separate round-trip query. Content-guard (bash isn't unit-testable here).
  test("Stop hook queries next-ready for a worker idle-ping, scoped to worker* only (not reviewer)", () => {
    const hook = readFileSync(join(assetsDir, "hooks/crew-worker-stop.sh"), "utf8");
    expect(hook).toContain("maw company task next-ready --company \"$MAW_ROOM_COMPANY\"");
    expect(hook).toContain('case "$CREW_ROLE" in\n  worker*)'); // queue query gated to worker*, not reviewer
    expect(hook).toContain('[ -n "$QUEUE" ] && MSG="$MSG · $QUEUE"'); // attached, not a separate hey
  });

  // kobo-356: the conductor-contract prose (§4c) tells the conductor-LLM what to DO with
  // the idle-ping's next-ready signal — the CLI verb + hook only carry the board-read,
  // the DECISION (dispatch / suggest-teardown) lives here as behavioral contract.
  test("conductor contract: NEXT-READY dispatches immediately; empty+all-idle SUGGESTS teardown (never auto)", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(skill).toContain("auto-reassign idle worker → next-ready");
    expect(skill).toContain("event-driven, board-read"); // no loop/poll — hook is the only trigger
    expect(skill).toContain("NEXT-READY <id>"); // has-ready-work branch → dispatch immediately
    expect(skill).toContain("NO-READY-WORK inFlight=<N>`, N>0"); // empty but work still coming back → note only
    expect(skill).toContain("NO-READY-WORK inFlight=0`"); // empty + nothing in flight → check all-idle next
    expect(skill).toContain("all-idle"); // roster-all-idle — NOT board-derivable, conductor's own knowledge
    expect(skill).toContain("SUGGEST เท่านั้น ห้าม auto"); // teardown = suggest-only, never auto-executed
    expect(skill).toContain("`/teardown`"); // reuses the existing shipped skill, doesn't reimplement
  });

  // kobo-150: crew SKILL forwards CREW_STATE_DIR (default ψ/active/crew, warroom
  // overrides to ψ/active/warroom) so the same spawn form works under the Conductor (kobo-157 rename).
  test("crew skill forwards CREW_STATE_DIR with the default state dir", () => {
    const crew = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(crew).toContain("${CREW_STATE_DIR:-ψ/active/crew}");
    expect(crew).toContain("CREW_STATE_DIR=");
  });

  // kobo-267: both spawns must stamp MAW_ROOM_COMPANY (from the company name crew
  // §0 resolves) so the statusline self-describes company → /api/presence?company=
  // can scope. Drop the stamp and the pane silently falls out of its board's
  // presence query, so guard it here (this is a CI-only isolated content gate).
  test("crew + head spawns stamp MAW_ROOM_COMPANY for presence scoping", () => {
    const crew = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(crew).toContain("CO_NAME="); // company name resolved in §0
    expect(crew).toContain("MAW_ROOM_COMPANY=");
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    expect(head).toContain("MAW_ROOM_COMPANY=");
  });

  // kobo-303 CUTOVER — /head (3-tier) replaced /warroom, which is now hard-removed.
  // kobo-317 — /worker (kobo-316) ALSO hard-removed: worker is no longer a self-defined standalone
  // skill, only a /crew-spawned in-cell pane (crew §4 inline contract). /head + /crew ship.
  // Both /warroom and /worker: no sync item, no asset file. The seat-resume hook KEEPS its
  // warroom-dir AND worker-dir support (asserted above) so any still-running pane survives the
  // skill removal — the skill file is gone, the runtime survival path is not.
  test("head + crew ship; /warroom and /worker are fully removed (kobo-303/317 cutover)", () => {
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/head/SKILL.md")).toBeDefined();
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/crew/SKILL.md")).toBeDefined();
    // /warroom hard-removed: no sync item, no asset file
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/warroom/SKILL.md")).toBeUndefined();
    expect(existsSync(join(assetsDir, "skills/warroom/SKILL.md"))).toBe(false);
    // kobo-317 — /worker hard-removed: no sync item, no asset file
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/worker/SKILL.md")).toBeUndefined();
    expect(existsSync(join(assetsDir, "skills/worker/SKILL.md"))).toBe(false);
  });

  // kobo-343 — /teardown = crew lifecycle close (spin↔teardown). Safety-critical pane killer:
  // kills ONLY crew-spawned panes (@role conductor/worker/reviewer), preserves invoker + untagged
  // (fail-closed). Graceful-wrap before kill (shutdown_request). Ships as a synced skill asset.
  test("teardown skill ships in SYNC_ITEMS and has safety-critical guards (kobo-343)", () => {
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/teardown/SKILL.md")).toBeDefined();
    expect(existsSync(join(assetsDir, "skills/teardown/SKILL.md"))).toBe(true);
    const skill = readFileSync(join(assetsDir, "skills/teardown/SKILL.md"), "utf8");
    // invoker-guard: capture ME from TMUX_PANE before the loop (order-critical, not just presence)
    const meIdx = skill.indexOf("ME");
    const loopIdx = skill.indexOf("kill-pane");
    expect(meIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(meIdx).toBeLessThan(loopIdx); // ME captured BEFORE any kill-pane (kobo-343 safety)
    // fail-closed: untagged/unknown origin → preserve, not kill
    expect(skill).toContain("fail-closed");
    // graceful-wrap: shutdown_request sent before kill
    expect(skill).toContain("shutdown_request");
    // crew roles targeted (all three spawned pane types from /crew §1)
    expect(skill).toContain("conductor");
    expect(skill).toContain("worker");
    expect(skill).toContain("reviewer");
    // @role is the crew-origin proof (set at /crew spawn time §1)
    expect(skill).toContain("@role");
    // TMUX_PANE and ME are the invoker guards
    expect(skill).toContain("TMUX_PANE");
    expect(skill).toContain("kill-pane");
  });

  // kobo-317 — the /crew worker pane offloads heavy exec to CC Task sub-agents and returns a
  // distilled result to the front (not a raw dump), keeping the durable tier lean. The worker
  // contract (crew §4) carries this instruction + the light-state re-seat rule.
  test("crew §4 worker contract instructs Task sub-agent offload → distilled to front (kobo-317)", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    // heavy exec offloads to a CC Task sub-agent
    expect(skill).toContain("Task sub-agent");
    // returns a distilled result, not raw
    expect(skill).toContain("distilled");
    // report-to = front
    expect(skill).toContain("คืน distilled result");
    // light state = standing task + held card (toilet/seat survives without full re-init)
    expect(skill).toContain("light state");
    expect(skill).toContain("standing task + held card");
  });

  // kobo-345 (v2 340b) — workers scale ×N: a bare BASE worker (§1, always present = worker-1-of-N)
  // PLUS dynamic numbered worker-N panes the conductor spawns/kills in W1 (§5). This lifts the
  // old kobo-319 single-worker cap (sonnet + ephemeral-kill make real pane parallelism affordable).
  // Pin BOTH: the base worker keeps its bare deadlock-critical form, AND the §5 recipe spawns +
  // KILLS numbered workers. The Stop-hook glob `worker*` must cover BOTH bare + worker-N (idle signal).
  test("crew v2: base worker bare + dynamic worker-N spawn/kill in W1 (kobo-345)", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    // base worker's bare CREW_ROLE=worker (not worker-1) moved into spawn.ts's self-heal
    // buildCmd with the rest of §1 (kobo-384) — pinned there now (plugin-crew-spawn.test.ts).
    expect(skill).toContain("$CREW_STATE_DIR/worker.md");
    expect(skill).toContain('"$WORKER:⚒ worker"');
    // §5 dynamic scale: spawn ADDITIONAL numbered workers (split into W1) + KILL them (despawn)
    expect(skill).toContain("CREW_ROLE=worker-");            // numbered additional workers
    expect(skill).toContain('tmux split-window -t "$WIN1_PANE"'); // spawn into the W1 window
    expect(skill).toContain("tmux kill-pane -t");            // the kill/despawn path (340b core)
    expect(skill).toContain("worker-$N-contract.md");        // per-worker contract file
    // deadlock-critical: the Stop-hook glob covers BOTH the bare base worker AND worker-N so every
    // worker fires its idle completion signal (kobo-91). `worker-*` alone would miss the bare base.
    const stopHook = readFileSync(join(assetsDir, "hooks/crew-worker-stop.sh"), "utf8");
    expect(stopHook).toContain("worker*|reviewer");
    expect(stopHook).not.toContain("worker-*|reviewer");
    // kobo-347: the SKILL PROSE describing the gate MUST match the hook (no dash). A future editor
    // trusting `worker-*` prose would rewrite the hook to `worker-*` → orphan the bare base worker =
    // cell deadlock. Pin the prose to the real glob so doc and hook can't drift.
    expect(skill).not.toContain("worker-*|reviewer");
    expect(skill).toContain("worker*|reviewer");
  });

  // kobo-384: the raw self-heal recipe (claude-sonnet-5 spawn, boot-fail/retry, new-window
  // form) moved entirely to spawn.ts crewSpawn() — single source, no more duplicate in
  // SKILL.md to drift. That behavior is pinned where it now lives: plugin-crew-spawn.test.ts
  // ("boots claude-sonnet-5 on first try", "boot-fail → kills orphan window, retries with
  // plain sonnet", "double-fail ... surfaces via maw hey with a RESOLVED addr"). This test
  // instead pins that SKILL.md §1 calls the verb and the duplicate recipe is actually gone.
  test("crew §1 calls the spawn verb — self-heal/model recipe no longer duplicated in SKILL.md (kobo-384)", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(skill).toContain('maw company crew spawn "$CO_NAME"');
    expect(skill).not.toContain("tmux new-window -P -F '#{pane_id}' -n crew-workers");
    expect(skill).not.toContain('claude --model "claude-sonnet-5"');
    expect(skill).not.toContain("claude --model claude-opus-5");
    // pane-ids still extracted for the auto-kick step (§ auto-kick) and worker-model.txt
    // still written for §5 worker-N reuse — same external contract as before
    expect(skill).toMatch(/FRONT=\$\(printf '%s' "\$_OUT"/);
    expect(skill).toContain('echo "$_WORKER_MODEL" > "$STATE_DIR/worker-model.txt"');
  });

  // kobo-353: conductor sets @task on dispatch, clears on idle — baked into dispatch recipe in §4c
  test("crew conductor: @task dispatch label recipe present (kobo-353)", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    expect(skill).toContain("@task");                                          // feature present
    expect(skill).toContain('tmux set-option -p -t');                          // tmux option verb
    expect(skill).toContain("@task \"\"");                                     // idle/done reset to ""
    expect(skill).toMatch(/@task "kobo-/);                                     // dispatch format kobo-<id>
    expect(skill).toContain("tmux list-panes -F '#{@role} #{@task}'");         // AC verify command
  });

  // kobo-384: the double-fail belt (_RETRY_BOOTED guard, resolved-addr hey front) moved to
  // spawn.ts crewSpawn() with the rest of self-heal — pinned there (plugin-crew-spawn.test.ts
  // "double-fail (both models fail to boot) → surfaces via maw hey with a RESOLVED addr, not a
  // bare pane-id"). kobo-381/382's conductor+reviewer model pin similarly moved — now the ONLY
  // place it's pinned is plugin-crew-spawn.test.ts ("conductor + reviewer spawn with the literal
  // model claude-opus-5"), since SKILL.md no longer duplicates the raw spawn command at all.

  // kobo-355: §5 worker-N self-heal parity — mirrors §1 (poll-verify + kill+retry + double-fail hey)
  test("crew §5 worker-N self-heal parity: poll-verify + retry + no-orphan + resolved-addr hey (kobo-355)", () => {
    const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
    const sec5Start = skill.indexOf("self-heal parity (kobo-355)");
    const sec5End = skill.indexOf("tmux set-option -p -t \"$NEW\" @role", sec5Start);
    const block5 = skill.slice(sec5Start, sec5End + 60);
    // initial boot polled (not assumed to succeed)
    expect(block5).toMatch(/_N_BOOTED=0/);
    expect(block5).toMatch(/for _i in/);
    // fail path: kill orphan pane
    expect(block5).toContain('tmux kill-pane -t "$NEW"');
    // retry with plain sonnet
    expect(block5).toContain('claude --model sonnet');
    // retry also polled
    expect(block5).toMatch(/_N_RETRY_BOOTED/);
    // addr resolved via tmux display-message before hey (not bare %pane-id — §3 convention)
    expect(block5).toContain('_COND_ADDR=$(tmux display-message -t "$COND"');
    expect(block5).toContain('#{session_name}:#{window_index}.#{pane_index}');
    // hey uses resolved addr, not bare $COND
    expect(block5).toContain('maw hey "$_COND_ADDR"');
    expect(block5).not.toContain('maw hey "$COND"');
    expect(block5).toContain('double-fail');
  });

  // kobo-358: contract text extracted from SKILL §4/4b/4c into standalone
  // contracts/{conductor,worker,reviewer}.md templates — single source that
  // `maw company crew spawn` CATs + substitutes (no LLM-fill, no version-skew).
  // SKILL.md keeps the prose (human docs) but now points to the asset as canonical.
  describe("crew contract templates extracted to standalone assets (kobo-358)", () => {
    test("contracts/{conductor,worker,reviewer}.md exist with {{COMPANY}}/{{DEPT}}/{{BOARD}} placeholders", () => {
      for (const role of ["conductor", "worker", "reviewer"]) {
        const tpl = readFileSync(join(assetsDir, "skills/crew/contracts", `${role}.md`), "utf8");
        expect(tpl).toContain("{{COMPANY}}");
        expect(tpl.length).toBeGreaterThan(200); // not a stub — real contract prose
      }
    });

    test("SYNC_ITEMS ships all 3 contract templates alongside SKILL.md", () => {
      for (const role of ["conductor", "worker", "reviewer"]) {
        expect(SYNC_ITEMS.find((i) => i.dest === `skills/crew/contracts/${role}.md`)).toBeDefined();
      }
    });

    test("SKILL.md §4/4b/4c reference the canonical asset (single-source, no duplicated maintenance)", () => {
      const skill = readFileSync(join(assetsDir, "skills/crew/SKILL.md"), "utf8");
      expect(skill).toContain("canonical asset (kobo-358)");
      expect(skill).toContain("contracts/conductor.md");
      expect(skill).toContain("contracts/worker.md");
      expect(skill).toContain("contracts/reviewer.md");
    });
  });

  test("head skill spawns the 3 head roles with global settings + presence stamp (kobo-299)", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    // 3-role head cell: lead + conductor + reviewer, comm opt-in
    expect(head).toContain("@role \"🎼 conductor\"");
    expect(head).toContain("@role \"🔎 reviewer\"");
    expect(head).toContain("@role \"👤 lead\"");
    // reviewer's Stop-hook wiring (--settings global path, deadlock-critical kobo-91/94) moved
    // into spawn.ts headSpawn() with the rest of the raw recipe (kobo-384) — pinned there now
    // (plugin-head-spawn.test.ts "reviewer (not conductor) gets --settings"). scratchpad's own
    // spawn line (still raw here, untouched by 384) also carries the global settings path —
    // that's a real, separate invariant this line still legitimately covers.
    expect(head).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
    expect(head).not.toContain("--settings .claude/crew-worker-settings.json");
    // scratchpad writes to ψ/active/head/ — CREW_STATE_DIR must follow (kobo-95, kobo-301)
    expect(head).toContain("CREW_STATE_DIR=ψ/active/head");
    // presence scoping (kobo-267)
    expect(head).toContain("MAW_ROOM_COMPANY=");
    // review chain wired head-reviewer → lead (299 AC)
    expect(head).toContain("worker → crew reviewer → head reviewer → lead");
    // opus top tier (299 AC — model-tier full mapping is sibling kobo-300); kobo-384: the
    // literal --model invocation moved to spawn.ts (single source) — pinned there now
    // (plugin-head-spawn.test.ts "happy path: 3-pane cell, both BRAIN_MODEL"). kobo-389:
    // the model-tier PROSE also stopped hardcoding the literal id (`BRAIN_MODEL` instead),
    // since the const is now the one place a model change happens.
    expect(head).toContain("BRAIN_MODEL");
    expect(head).not.toContain("claude-opus-5");
    expect(head).toContain("model tier (spawn)");
  });

  // kobo-300 — model tier: แพงบน-ถูกล่าง. head lead/conductor/reviewer = opus (judgment),
  // comm = sonnet (relay, high-volume low-judgment — same as warroom). worker .3 caught A
  // shipping comm=opus, off-spec; this pins comm sonnet so a regression can't slip back.
  test("head comm spawns with --model sonnet, not opus (kobo-300 tier fix)", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    // the comm spawn line uses sonnet
    const commSpawn = head.split("\n").find((l) => l.includes("comm-contract.md") && l.includes("--model"));
    expect(commSpawn).toBeDefined();
    expect(commSpawn).toContain("--model sonnet");
    expect(commSpawn).not.toContain("--model opus");
    // no comm pane left on opus anywhere (roster row + contract heading)
    expect(head).not.toContain("| comm       | %720    | opus");
    expect(head).not.toContain("comm 📡 · opt-in · opus");
    // full tier mapping table present (opus top · sonnet worker/scratchpad/comm)
    expect(head).toContain("model tier (spawn)");
    expect(head).toContain("worker×3 | **sonnet**");
  });

  // kobo-301 — the scratchpad is a read-only grounding role: it fetches sources into a
  // digest but must NOT mutate. The guard is structural (--disallowedTools hard-blocks the
  // write tools, and survives --dangerously-skip-permissions since disallow = exclude, not
  // prompt) + contract discipline for bash. Pin the structural guard so a spawn edit can't
  // silently drop it and hand scratchpad a write path.
  test("scratchpad spawns read-only — --disallowedTools blocks write tools (kobo-301)", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    const spawn = head.split("\n").find((l) => l.includes("scratchpad-contract.md") && l.includes("claude --model"));
    expect(spawn).toBeDefined();
    // sonnet tier (kobo-300) + autonomous (no blackhole) + structural no-write guard
    expect(spawn).toContain("--model sonnet");
    expect(spawn).toContain("--dangerously-skip-permissions");
    expect(spawn).toContain('--disallowedTools "Write Edit MultiEdit NotebookEdit"');
    // read-only role is explicit in the contract (defense-in-depth: bash discipline too)
    expect(head).toContain("read-only grounding");
    expect(head).toContain("no-write guard");
  });

  // kobo-304 — the worker cell (execution tier) IS the existing /crew, reused, not a new
  // spawn machinery. Pin that /head documents the nesting (crew → /crew) but does NOT
  // re-implement the /crew worker spawn — a future edit that copies /crew's split-window
  // spawn form into the worker-cell section would fork the kernel (drift). The only
  // worker-spawn split-window forms in this skill are for the HEAD panes (conductor,
  // reviewer, comm, scratchpad); the worker cell delegates to /crew.
  test("worker cell reuses /crew, not a re-implementation (kobo-304)", () => {
    const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
    // the execution tier is documented as /crew reuse
    expect(head).toContain("Worker cell (execution tier · = /crew");
    // nesting is via invoking /crew (single kernel source), not a fresh spawn form
    expect(head).toContain("invoke `/crew`");
    // the worker-cell section names no new CREW_ROLE=worker spawn (that lives in /crew)
    const wcSection = head.slice(head.indexOf("## Worker cell"), head.indexOf("## lead-toilet-survive"));
    expect(wcSection).not.toContain("CREW_ROLE=worker");
    expect(wcSection).not.toContain("split-window"); // no re-implemented spawn machinery
  });

  // kobo-364: contract text extracted from head SKILL's Conductor/Reviewer
  // Contract sections into standalone contracts/{conductor,reviewer}.md
  // templates — same treatment kobo-358 gave /crew's §4/4b/4c. NO lead.md:
  // lead is the invoking pane, never spawned, never gets --append-system-prompt.
  describe("head contract templates extracted to standalone assets (kobo-364)", () => {
    test("contracts/{conductor,reviewer}.md exist with {{COMPANY}}/{{DEPT}}/{{BOARD}} placeholders, no lead.md", () => {
      for (const role of ["conductor", "reviewer"]) {
        const tpl = readFileSync(join(assetsDir, "skills/head/contracts", `${role}.md`), "utf8");
        expect(tpl).toContain("{{COMPANY}}");
        expect(tpl.length).toBeGreaterThan(200); // not a stub — real contract prose
      }
      expect(existsSync(join(assetsDir, "skills/head/contracts/lead.md"))).toBe(false);
    });

    test("SYNC_ITEMS ships both head contract templates", () => {
      for (const role of ["conductor", "reviewer"]) {
        expect(SYNC_ITEMS.find((i) => i.dest === `skills/head/contracts/${role}.md`)).toBeDefined();
      }
      expect(SYNC_ITEMS.find((i) => i.dest === "skills/head/contracts/lead.md")).toBeUndefined();
    });

    test("head SKILL.md's Conductor/Reviewer Contract sections reference the canonical asset", () => {
      const head = readFileSync(join(assetsDir, "skills/head/SKILL.md"), "utf8");
      expect(head).toContain("canonical asset (kobo-364)");
      expect(head).toContain("contracts/conductor.md");
      expect(head).toContain("contracts/reviewer.md");
    });
  });
});

describe("crew-skills sync", () => {
  test("fresh install writes all items, hook is executable", () => {
    const home = freshHome();
    const result = syncCrewSkills({ home, assetsDir, repoDir: freshHome() });

    expect(result.installed.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
    expect(result.skipped).toEqual([]);
    for (const item of SYNC_ITEMS) {
      expect(existsSync(join(home, ".claude", item.dest))).toBe(true);
    }
    const hookMode = statSync(join(home, ".claude/hooks/crew-worker-stop.sh")).mode & 0o111;
    expect(hookMode).not.toBe(0); // some exec bit set

    // installed content matches canonical assets
    const crew = readFileSync(join(home, ".claude/skills/crew/SKILL.md"), "utf8");
    expect(crew).toContain('--settings "$HOME/.claude/crew-worker-settings.json"');
  });

  test("second sync is idempotent (everything up-to-date)", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const again = syncCrewSkills({ home, assetsDir, repoDir });
    expect(again.installed).toEqual([]);
    expect(again.skipped.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
  });

  test("drifted file is re-synced back to canonical", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const crewDest = join(home, ".claude/skills/crew/SKILL.md");
    writeFileSync(crewDest, "STALE COPY");

    const result = syncCrewSkills({ home, assetsDir, repoDir });
    expect(result.installed).toContain("skills/crew/SKILL.md");
    expect(readFileSync(crewDest, "utf8")).not.toBe("STALE COPY");
  });

  test("--force rewrites even when unchanged", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const forced = syncCrewSkills({ home, assetsDir, repoDir, force: true });
    expect(forced.installed.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
  });

  test("--dry-run reports changes but writes nothing", () => {
    const home = freshHome();
    const result = syncCrewSkills({ home, assetsDir, repoDir: freshHome(), dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.installed.length).toBe(SYNC_ITEMS.length);
    expect(existsSync(join(home, ".claude/skills/crew/SKILL.md"))).toBe(false);
    expect(formatSyncResult(result)).toContain("would install");
  });

  test("wires the SessionStart seat-resume hook into the REPO settings, not global (scoped-both)", () => {
    const home = freshHome();
    const repoDir = freshHome(); // stands in for the oracle repo dir
    const result = syncCrewSkills({ home, assetsDir, repoDir });
    expect(result.seatHookWired).toBe(true);
    // asset script still installs globally (~/.claude/hooks) — unchanged
    expect(existsSync(join(home, ".claude/hooks/seat-resume.sh"))).toBe(true);
    // the wiring lands in the REPO's .claude/settings.json … (kobo-268: startup|resume|clear)
    const settings = JSON.parse(readFileSync(join(repoDir, ".claude/settings.json"), "utf8"));
    const entry = settings.hooks.SessionStart.find((e: any) => e.matcher === "startup|resume|clear");
    expect(entry.hooks[0].command).toBe("bash $HOME/.claude/hooks/seat-resume.sh");
    // … and NEVER the user's global ~/.claude/settings.json (worker.3 reject)
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
  });

  test("seat-resume hook wiring is idempotent (no duplicate entry)", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const again = syncCrewSkills({ home, assetsDir, repoDir });
    expect(again.seatHookWired).toBe(false);
    const settings = JSON.parse(readFileSync(join(repoDir, ".claude/settings.json"), "utf8"));
    const seats = settings.hooks.SessionStart.filter((e: any) => e.matcher === "startup|resume|clear");
    expect(seats.length).toBe(1);
  });

  // kobo-268 — a re-sync UPGRADES an old clear-only install to startup|resume|clear in place
  // (by matching the command), never leaving a stale clear-only entry or duplicating.
  test("seat-resume wiring upgrades an old clear-only matcher in place", () => {
    const home = freshHome();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ matcher: "clear", hooks: [{ type: "command", command: "bash $HOME/.claude/hooks/seat-resume.sh" }] }] },
    }));
    expect(ensureSeatResumeHook(claudeDir)).toBe(true); // upgraded
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    const entries = settings.hooks.SessionStart;
    expect(entries.length).toBe(1); // upgraded in place, not duplicated
    expect(entries[0].matcher).toBe("startup|resume|clear");
    expect(ensureSeatResumeHook(claudeDir)).toBe(false); // now current — no-op
  });

  // kobo-566 — sync now prunes dests it previously installed (tracked in its own
  // manifest) that have since dropped out of SYNC_ITEMS, instead of leaving them
  // as permanent stale no-ops (kobo-317's /worker was the proof case).
  describe("prune (kobo-566)", () => {
    test("fresh install (no prior manifest) writes a manifest matching current SYNC_ITEMS, prunes nothing", () => {
      const home = freshHome();
      const result = syncCrewSkills({ home, assetsDir, repoDir: freshHome() });
      expect(result.pruned).toEqual([]);
      const manifest = JSON.parse(readFileSync(join(home, ".claude/.crew-skills-manifest.json"), "utf8"));
      expect(manifest.installed.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
    });

    test("a dest tracked in the manifest but no longer in SYNC_ITEMS is deleted from disk and reported pruned", () => {
      const home = freshHome();
      const repoDir = freshHome();
      syncCrewSkills({ home, assetsDir, repoDir }); // seeds a real manifest

      // simulate a stale entry: a dest this tool once installed, now dropped from SYNC_ITEMS
      const claudeDir = join(home, ".claude");
      const staleDest = "skills/worker/SKILL.md";
      const staleAbs = join(claudeDir, staleDest);
      mkdirSync(join(claudeDir, "skills/worker"), { recursive: true });
      writeFileSync(staleAbs, "stale worker skill, kobo-317 removed it from SYNC_ITEMS");
      const manifestPath = join(claudeDir, ".crew-skills-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.installed.push(staleDest);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = syncCrewSkills({ home, assetsDir, repoDir });
      expect(result.pruned).toContain(staleDest);
      expect(existsSync(staleAbs)).toBe(false);
      // manifest re-written to just the current items — stale dest drops out for good
      const after = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(after.installed).not.toContain(staleDest);
    });

    test("--dry-run reports what would be pruned but deletes nothing and does not touch the manifest", () => {
      const home = freshHome();
      const repoDir = freshHome();
      syncCrewSkills({ home, assetsDir, repoDir });
      const claudeDir = join(home, ".claude");
      const staleDest = "skills/worker/SKILL.md";
      const staleAbs = join(claudeDir, staleDest);
      mkdirSync(join(claudeDir, "skills/worker"), { recursive: true });
      writeFileSync(staleAbs, "stale");
      const manifestPath = join(claudeDir, ".crew-skills-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.installed.push(staleDest);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const manifestMtimeBefore = statSync(manifestPath).mtimeMs;

      const result = syncCrewSkills({ home, assetsDir, repoDir, dryRun: true });
      expect(result.pruned).toContain(staleDest);
      expect(existsSync(staleAbs)).toBe(true); // untouched
      expect(statSync(manifestPath).mtimeMs).toBe(manifestMtimeBefore); // untouched
      expect(formatSyncResult(result)).toContain("would prune");
    });

    test("a file from another source (never in this tool's manifest) is never deleted, even if absent from SYNC_ITEMS", () => {
      const home = freshHome();
      const claudeDir = join(home, ".claude");
      // simulate an arra-oracle-set skill or an external symlink target already
      // sitting in .claude/skills before crew-skills ever ran here
      const otherDest = "skills/recap/SKILL.md";
      const otherAbs = join(claudeDir, otherDest);
      mkdirSync(join(claudeDir, "skills/recap"), { recursive: true });
      writeFileSync(otherAbs, "not ours — arra-oracle skill set");

      const repoDir = freshHome();
      syncCrewSkills({ home, assetsDir, repoDir }); // first run: no manifest yet, otherDest untracked
      expect(existsSync(otherAbs)).toBe(true);

      const again = syncCrewSkills({ home, assetsDir, repoDir }); // second run: manifest now exists, still never mentions otherDest
      expect(again.pruned).not.toContain(otherDest);
      expect(existsSync(otherAbs)).toBe(true);
    });
  });

  test("seat-resume wiring preserves pre-existing settings + hooks (non-destructive)", () => {
    const home = freshHome();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
      model: "opus",
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "keep-me.sh" }] }] },
    }));
    ensureSeatResumeHook(claudeDir);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.SessionStart.some((e: any) => e.hooks[0].command === "keep-me.sh")).toBe(true);
    expect(settings.hooks.SessionStart.some((e: any) => e.matcher === "startup|resume|clear")).toBe(true); // kobo-268
  });
});
