/**
 * `maw company head spawn <company>` — deterministic, idempotent head-cell
 * spawn (kobo-364). Same treatment kobo-358 gave /crew: ports the /head SKILL
 * spawn recipe from Claude-Code-skill PROSE into this binary verb, eliminating
 * the LLM-fill step that caused version-skew for /crew (an old session
 * re-interpreting old prose could stack a spawn on top of leftovers).
 *
 * unified principle (kobo-358 eq3 ruling, reused as-is): verb = layout +
 * role-env + CAT-asset(mechanics) · asset files (crew-skills contracts/*.md)
 * = contract text (editable, single source) · binary = ZERO behavior/contract
 * text.
 *
 * eq3 kobo-364 ruling — SELF-HEAL DOES NOT APPLY THE SAME WAY: kobo-358's
 * self-heal existed because sonnet[1m]/claude-sonnet-5 is account-gated with a
 * cheaper fallback tier (plain sonnet) to degrade to. head is opus-only for
 * ALL 3 roles (judgment tier, no blessed fallback) — so head-spawn polls to
 * VERIFY boot succeeded, but never falls back to a cheaper model. A boot
 * failure is a LOUD, human-surfaced error (`maw hey` to the lead pane's own
 * resolved address, not just a log line — a silent log is not loud), never a
 * silent downgrade of the strategic tier.
 *
 * SCOPE-OUT (eq3 kobo-364 ruling):
 *   - NO worker window / worker pane — head ≠ crew (3-pane core only: lead +
 *     conductor + reviewer). comm (📡, opt-in in the SKILL) is NOT part of
 *     this binary verb — no existing consumer requires it for "ready".
 *   - ZERO changes to company-fleet.ts (kobo-362, already merged/arc-closed).
 *     Its manager-repair report-only path already expects exactly this
 *     3-pane set (👤+🎼+🔎) — wiring company-fleet.ts to CALL this verb is a
 *     separate follow-up card, not part of this one.
 *   - NO lead.md contract asset — lead is the invoking pane, never spawned,
 *     never gets `--append-system-prompt` (matches the /head SKILL's own
 *     spawn recipe, which only cats contract files for conductor/reviewer).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostExec } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { loadCompany } from "../company/company-helpers";
import { scopeOfOracle } from "../../../core/worklog/company-scope";
import { teardownCrewWindows } from "../crew/teardown";

// overridable for tests only (HEAD_SPAWN_POLL_MS) — production always polls at
// 2s; read at call-time (not module load) so a test can set it in beforeEach.
function bootPollMs(): number {
  const override = Number(process.env.HEAD_SPAWN_POLL_MS);
  return Number.isFinite(override) && override > 0 ? override : 2000;
}
const BOOT_POLL_MAX = 10; // 20s — CC TUI boot often >3s, fixed sleep is unreliable
// boot-fail signals — anything OTHER than a clean boot (ambiguity → treated as
// fail, same fail-safe direction as kobo-352/358's model-boot probes).
const BOOT_FAIL_RE = /not available for your account|unknown model|invalid model|no such model/i;

const STATE_FILES = [
  "conductor.md", "reviewer.md", "digest.md",
  "conductor-contract.md", "reviewer-contract.md",
];

type Role = "conductor" | "reviewer";

function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// process.env.HOME first, homedir() fallback — bun's os.homedir() does not
// reflect an overridden HOME env var (kobo-358 finding), so a bare homedir()
// call is untestable without mocking node:os globally (breaks bun's own
// test-runner internals). Checking HOME first is a no-op on any normal shell.
function resolveHome(): string {
  return process.env.HOME || homedir();
}

function contractAssetPath(role: Role): string {
  return join(resolveHome(), ".claude", "skills", "head", "contracts", `${role}.md`);
}

function renderContract(role: Role, vars: { company: string; dept: string; board: string }): string {
  const tpl = readFileSync(contractAssetPath(role), "utf8");
  return tpl
    .replaceAll("{{COMPANY}}", vars.company)
    .replaceAll("{{DEPT}}", vars.dept)
    .replaceAll("{{BOARD}}", vars.board);
}

async function capturePane(paneId: string): Promise<string> {
  try {
    return await hostExec(`tmux capture-pane -t ${shellArg(paneId)} -p -S -20`);
  } catch {
    return "";
  }
}

// kobo-364 empirical finding: head's 3-way split (lead+conductor+reviewer all
// sharing one window) makes the reviewer pane genuinely narrow in a normal
// terminal (~19 cols observed live) — the CC TUI's "bypass permissions on"
// footer doesn't fit and the status line renders truncated, so a width-bound
// substring check FALSE-NEGATIVEs a pane that actually booted fine. crew's
// worker check never hit this because `tmux new-window` gives it a full-width
// pane, not a narrowing split. The input-prompt marker "❯" on its own line
// (boxed by "───" rules) renders regardless of pane width — verified live in
// both the wide conductor pane and the narrow reviewer pane.
const BOOT_READY_RE = /^❯\s*$/m;

/** poll boot up to maxTries; true = confirmed booted, false = timeout/fail-signal (ambiguity → false, fail-safe). */
async function pollBoot(paneId: string, maxTries: number): Promise<boolean> {
  for (let i = 0; i < maxTries; i++) {
    await sleep(bootPollMs());
    const boot = await capturePane(paneId);
    if (!boot) continue; // empty capture — pane not ready yet, keep polling
    if (BOOT_FAIL_RE.test(boot)) return false;
    // "bypass permissions on" is a strong signal when the pane is wide enough
    // to render it; the "❯" prompt marker is the width-independent fallback
    // (always on its own line once the TUI is interactive, narrow or not).
    if (boot.includes("bypass permissions") || BOOT_READY_RE.test(boot)) return true;
  }
  return false;
}

/** Surface a boot-fail LOUDLY (maw hey to the lead pane's own resolved addr —
 * never just a log line). Best-effort: a notify failure doesn't mask the
 * original error. */
async function notifyBootFailLoud(leadPane: string, message: string): Promise<void> {
  try {
    const leadAddr = (await hostExec(`tmux display-message -t ${shellArg(leadPane)} -p '#{session_name}:#{window_index}.#{pane_index}'`)).trim();
    await hostExec(`maw hey ${shellArg(leadAddr)} ${shellArg(message)}`);
  } catch { /* best-effort notify — the returned error is the real signal */ }
}

export interface HeadSpawnResult {
  ok: boolean;
  error?: string;
  lead?: string;
  conductor?: string;
  reviewer?: string;
}

export async function headSpawn(company: string | undefined, emit: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
  if (!company) return { ok: false, error: "usage: maw company head spawn <company>" };

  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company} — no partial spawn` };

  const lead = (process.env.TMUX_PANE || "").trim();
  if (!lead) return { ok: false, error: "not inside a tmux pane (TMUX_PANE unset) — run from a raw claude pane" };

  for (const role of ["conductor", "reviewer"] as Role[]) {
    if (!existsSync(contractAssetPath(role))) {
      return { ok: false, error: `contract asset missing: ${contractAssetPath(role)} — run maw crew-skills sync first` };
    }
  }

  // idempotency: detect + kill leftover head panes in THIS session first
  // (fail-closed on unknown). Reused AS-IS from kobo-358/362 — `lead` here is
  // ALWAYS the invoking pane (guaranteed non-empty by the check above), so the
  // kobo-362 empty-protectPaneId entry-guard never trips on this call-path —
  // same construction as crewSpawn's `front`, zero regression risk.
  const teardown = await teardownCrewWindows({ protectPaneId: lead });
  for (const line of teardown.logs) emit(line);
  if (!teardown.ok) return { ok: false, error: teardown.error };

  const oracle = ((loadConfig() as Record<string, unknown>).oracle as string) || "";
  const scope = scopeOfOracle(oracle);
  const dept = scope?.dept ?? "";
  const board = company;

  const stateDir = process.env.CREW_STATE_DIR || "ψ/active/head";
  mkdirSync(stateDir, { recursive: true });
  for (const f of STATE_FILES) {
    try { rmSync(join(stateDir, f)); } catch { /* not present — fine */ }
  }

  await hostExec(`tmux set-option -p -t ${shellArg(lead)} @role ${shellArg("👤 lead")}`);

  writeFileSync(join(stateDir, "conductor-contract.md"), renderContract("conductor", { company, dept, board }));
  writeFileSync(join(stateDir, "reviewer-contract.md"), renderContract("reviewer", { company, dept, board }));

  const cwd = process.cwd();
  const settingsPath = join(resolveHome(), ".claude", "crew-worker-settings.json");

  // conductor — opus, NO --settings/CREW_ROLE (no Stop hook, mirrors crew's own conductor)
  const condCmd = `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model opus --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "conductor-contract.md"))})"`;
  const conductor = (await hostExec(`tmux split-window -h -t ${shellArg(lead)} -P -F '#{pane_id}' ${shellArg(condCmd)}`)).trim();
  if (!conductor) return { ok: false, error: "conductor spawn produced no pane-id" };

  const conductorBooted = await pollBoot(conductor, BOOT_POLL_MAX);
  if (!conductorBooted) {
    const msg = `[head spawn boot-fail] conductor (opus) failed to boot for '${company}' — manual recovery needed (kobo-364)`;
    await notifyBootFailLoud(lead, msg);
    emit(`⚠ conductor boot-fail — surfaced via maw hey, pane left up for manual inspection`);
    return { ok: false, error: "conductor failed to boot (opus) — see notify" };
  }

  // reviewer — opus, WITH --settings (Stop hook), coord=conductor
  const revCmd = `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=reviewer CREW_COORD_PANE=${shellArg(conductor)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model opus --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "reviewer-contract.md"))})"`;
  const reviewer = (await hostExec(`tmux split-window -h -t ${shellArg(lead)} -P -F '#{pane_id}' ${shellArg(revCmd)}`)).trim();
  if (!reviewer) return { ok: false, error: "reviewer spawn produced no pane-id" };

  const reviewerBooted = await pollBoot(reviewer, BOOT_POLL_MAX);
  if (!reviewerBooted) {
    const msg = `[head spawn boot-fail] reviewer (opus) failed to boot for '${company}' — manual recovery needed (kobo-364)`;
    await notifyBootFailLoud(lead, msg);
    emit(`⚠ reviewer boot-fail — surfaced via maw hey, pane left up for manual inspection`);
    return { ok: false, error: "reviewer failed to boot (opus) — see notify" };
  }

  await hostExec(`tmux set-option -p -t ${shellArg(conductor)} @role ${shellArg("🎼 conductor")}`);
  await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @role ${shellArg("🔎 reviewer")}`);

  emit(`✓ head spawned — lead=${lead} conductor=${conductor} reviewer=${reviewer}`);
  return { ok: true };
}
