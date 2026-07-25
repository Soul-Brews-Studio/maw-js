/**
 * `maw company crew spawn <company>` — deterministic, idempotent crew-cell
 * spawn (kobo-358). Ports the /crew SKILL §1 tmux recipe from Claude-Code-skill
 * PROSE into this binary verb, eliminating the LLM-fill step that caused
 * version-skew: an old session interpreting old SKILL.md prose could stack a
 * v2 spawn on top of v1 leftovers (dup crew-workers windows observed live).
 *
 * unified principle (eq3 kobo-358 ruling): verb = layout + role-env +
 * CAT-asset(mechanics) · asset files (crew-skills contracts/*.md) = contract
 * text (editable, single source) · binary = ZERO behavior/contract text.
 *
 * SCOPE-OUT: no role behavior changes · no /teardown skill rewrite (separate
 * follow-up) · no dynamic worker-scale logic (kobo-345, still SKILL §5 prose).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostExec } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { loadCompany } from "../company/company-helpers";
import { scopeOfOracle } from "../../../core/worklog/company-scope";
import { teardownCrewWindows } from "./teardown";

// kobo-358 Tony directive (post-cutoff model, DO NOT normalize/correct to a
// pre-cutoff string): default the worker to claude-sonnet-5 verbatim. Self-heal
// (ported from kobo-352) makes the exact string non-critical — an unavailable
// model degrades to plain `sonnet`, never a hard-fail/deadlock.
export const DEFAULT_WORKER_MODEL = "claude-sonnet-5";
export const FALLBACK_WORKER_MODEL = "sonnet";
// kobo-389: single source for the brain tier (conductor/reviewer, both crew and head) —
// the literal id, not the `opus` alias (kobo-382: `opus` resolves to Opus 4.8, not 5).
// head/spawn.ts imports this rather than duplicating the string a 3rd/4th time.
export const BRAIN_MODEL = "claude-opus-5";
const CREW_WORKERS_WINDOW = "crew-workers";
// overridable for tests only (CREW_SPAWN_POLL_MS) — production always polls at 2s;
// read at call-time (not module load) so a test can set it in beforeEach.
function bootPollMs(): number {
  const override = Number(process.env.CREW_SPAWN_POLL_MS);
  return Number.isFinite(override) && override > 0 ? override : 2000;
}
const BOOT_POLL_MAX = 10; // 20s — CC TUI boot often >3s, fixed sleep is unreliable
const RETRY_POLL_MAX = 5; // 10s
// boot-fail signals — anything OTHER than a clean boot (ambiguity → treated as
// fail, same fail-safe direction as kobo-352's 1M-probe).
const BOOT_FAIL_RE = /not available for your account|unknown model|invalid model|no such model/i;

const STATE_FILES = [
  "conductor.md", "worker.md", "reviewer.md",
  "conductor-contract.md", "worker-contract.md", "reviewer-contract.md",
];

type Role = "conductor" | "worker" | "reviewer";

function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// process.env.HOME first, homedir() fallback — bun's os.homedir() does not
// reflect an overridden HOME env var (verified empirically, kobo-358), so a
// bare homedir() call is untestable without mocking node:os globally (which
// broke bun's own test-runner internals when tried). Checking HOME first is
// the standard CLI convention and is a no-op on any normal shell (HOME is
// always set), so this changes nothing outside tests.
function resolveHome(): string {
  return process.env.HOME || homedir();
}

function contractAssetPath(role: Role): string {
  return join(resolveHome(), ".claude", "skills", "crew", "contracts", `${role}.md`);
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

/** poll boot up to maxTries; true = confirmed booted, false = timeout/fail-signal (ambiguity → false, fail-safe). */
async function pollBoot(paneId: string, maxTries: number): Promise<boolean> {
  for (let i = 0; i < maxTries; i++) {
    await sleep(bootPollMs());
    const boot = await capturePane(paneId);
    if (!boot) continue; // empty capture — pane not ready yet, keep polling
    if (BOOT_FAIL_RE.test(boot)) return false;
    // "bypass permissions on" footer = the CC TUI is up and running, regardless
    // of the exact per-model status label (kobo-358: don't hardcode a guessed
    // display string for a model released after this binary's knowledge cutoff).
    if (boot.includes("bypass permissions")) return true;
  }
  return false;
}

export interface CrewSpawnResult {
  ok: boolean;
  error?: string;
  front?: string;
  conductor?: string;
  worker?: string;
  workerModel?: string;
  reviewer?: string;
}

export async function crewSpawn(company: string | undefined, emit: (line: string) => void): Promise<CrewSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company crew spawn <company>" };

  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company} — no partial spawn` };

  const front = (process.env.TMUX_PANE || "").trim();
  if (!front) return { ok: false, error: "not inside a tmux pane (TMUX_PANE unset) — run from a raw claude pane" };

  for (const role of ["conductor", "worker", "reviewer"] as Role[]) {
    if (!existsSync(contractAssetPath(role))) {
      return { ok: false, error: `contract asset missing: ${contractAssetPath(role)} — run maw crew-skills sync first` };
    }
  }

  // idempotency: detect + kill leftover crew panes in THIS session first (fail-closed on unknown)
  const teardown = await teardownCrewWindows({ protectPaneId: front });
  for (const line of teardown.logs) emit(line);
  if (!teardown.ok) return { ok: false, error: teardown.error };

  const oracle = ((loadConfig() as Record<string, unknown>).oracle as string) || "";
  const scope = scopeOfOracle(oracle);
  const dept = scope?.dept ?? "";
  const board = company;

  const stateDir = process.env.CREW_STATE_DIR || "ψ/active/crew";
  mkdirSync(stateDir, { recursive: true });
  for (const f of STATE_FILES) {
    try { rmSync(join(stateDir, f)); } catch { /* not present — fine */ }
  }

  await hostExec(`tmux set-option -p -t ${shellArg(front)} @role ${shellArg("🧭 coord")}`);

  writeFileSync(join(stateDir, "conductor-contract.md"), renderContract("conductor", { company, dept, board }));
  writeFileSync(join(stateDir, "worker-contract.md"), renderContract("worker", { company, dept, board }));
  writeFileSync(join(stateDir, "reviewer-contract.md"), renderContract("reviewer", { company, dept, board }));

  const cwd = process.cwd();
  const settingsPath = join(resolveHome(), ".claude", "crew-worker-settings.json");

  // W0 brains layout (kobo-375): front LEFT 50% full-height, conductor/reviewer
  // stacked RIGHT 25/25. conductor splits off front (-h -p 50 → front|conductor
  // 50/50), then reviewer splits off conductor (-v -p 50, of the right half →
  // conductor top-25/reviewer bottom-25 of the whole). -p 50 explicit (not
  // relying on tmux's implicit default) so the ratio can't silently drift.
  // conductor (.1) — no --settings (brains, no Stop hook — mirrors head conductor); --model
  // BRAIN_MODEL (kobo-389: single source, was a duplicated literal — kobo-382 missed a site)
  const condCmd = `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${BRAIN_MODEL} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "conductor-contract.md"))})"`;
  const conductor = (await hostExec(`tmux split-window -h -p 50 -t ${shellArg(front)} -P -F '#{pane_id}' ${shellArg(condCmd)}`)).trim();

  const workerResult = await spawnWorkerSelfHeal({ cwd, company, stateDir, coordPane: conductor, settingsPath, front, emit });
  if (!workerResult.ok || !workerResult.paneId) return { ok: false, error: workerResult.error ?? "worker spawn failed" };

  // reviewer (.3) — WITH --settings (Stop hook), coord=front. split off CONDUCTOR
  // (not front) so it lands top/bottom on the right half instead of a 3rd column.
  const revCmd = `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=reviewer CREW_COORD_PANE=${shellArg(front)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${BRAIN_MODEL} --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "reviewer-contract.md"))})"`;
  const reviewer = (await hostExec(`tmux split-window -v -p 50 -t ${shellArg(conductor)} -P -F '#{pane_id}' ${shellArg(revCmd)}`)).trim();

  await hostExec(`tmux set-option -p -t ${shellArg(conductor)} @role ${shellArg("🎼 conductor")}`);
  await hostExec(`tmux set-option -p -t ${shellArg(workerResult.paneId)} @role ${shellArg("⚒ worker")}`);
  await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @role ${shellArg("🔎 reviewer")}`);

  emit(`✓ crew spawned — front=${front} conductor=${conductor} worker=${workerResult.paneId} (${workerResult.model}) reviewer=${reviewer}`);
  // kobo-384: populate the already-declared CrewSpawnResult (was silently discarded as
  // `{ ok: true }`) — SKILL.md's auto-kick step needs these pane-ids to fire the first
  // hey per spawned pane, and the emit() log stream is the only place that carried them.
  return { ok: true, front, conductor, worker: workerResult.paneId, workerModel: workerResult.model, reviewer };
}

interface WorkerSpawnResult { ok: boolean; error?: string; paneId?: string; model?: string }

/** self-heal worker spawn (ported from kobo-352 §1, extended kobo-358): boot
 * DEFAULT_WORKER_MODEL → poll-verify → on fail, kill orphan + retry
 * FALLBACK_WORKER_MODEL → poll-verify the retry too. Double-fail surfaces to
 * front via `maw hey` (resolved session:window.pane addr, not a bare %pane-id
 * — kobo-354/355 lesson). Never hard-fails the spawn. */
async function spawnWorkerSelfHeal(opts: {
  cwd: string; company: string; stateDir: string; coordPane: string; settingsPath: string; front: string;
  emit: (line: string) => void;
}): Promise<WorkerSpawnResult> {
  const { cwd, company, stateDir, coordPane, settingsPath, front, emit } = opts;
  const buildCmd = (model: string) =>
    `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=worker CREW_COORD_PANE=${shellArg(coordPane)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${shellArg(model)} --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "worker-contract.md"))})"`;

  let model = DEFAULT_WORKER_MODEL;
  let paneId = (await hostExec(`tmux new-window -P -F '#{pane_id}' -n ${CREW_WORKERS_WINDOW} ${shellArg(buildCmd(model))}`)).trim();
  if (!paneId) return { ok: false, error: "worker spawn produced no pane-id" };

  let booted = await pollBoot(paneId, BOOT_POLL_MAX);
  if (booted) return { ok: true, paneId, model };

  // fail → kill orphan, retry fallback model, poll-verify the retry too
  try { await hostExec(`tmux kill-window -t ${shellArg(paneId)}`); } catch { /* already gone */ }
  model = FALLBACK_WORKER_MODEL;
  paneId = (await hostExec(`tmux new-window -P -F '#{pane_id}' -n ${CREW_WORKERS_WINDOW} ${shellArg(buildCmd(model))}`)).trim();
  if (!paneId) return { ok: false, error: "worker retry-spawn produced no pane-id" };

  booted = await pollBoot(paneId, RETRY_POLL_MAX);
  if (booted) return { ok: true, paneId, model };

  // double-fail: worker lost — surface immediately (never silently deadlock)
  try {
    const frontAddr = (await hostExec(`tmux display-message -t ${shellArg(front)} -p '#{session_name}:#{window_index}.#{pane_index}'`)).trim();
    await hostExec(`maw hey ${shellArg(frontAddr)} ${shellArg(`[crew spawn double-fail] worker failed ${DEFAULT_WORKER_MODEL}+${FALLBACK_WORKER_MODEL} boot — manual recovery needed (kobo-358)`)}`);
  } catch { /* best-effort notify */ }
  emit("⚠ worker double-fail — surfaced to front, pane left up for manual inspection");
  return { ok: true, paneId, model }; // pane stays up (manual recovery) — not a hard spawn failure
}
