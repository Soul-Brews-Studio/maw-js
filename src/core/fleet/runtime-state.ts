import type { FleetRuntimeIdentity } from "./fleet-load-core";

// Fleet-child runtime recovery — reader side (#dept-roster D-5).
//
// Consumes the `runtime` (and optional `runtime.launch`) record that a captured
// fleet window carries, so an exact bare-name wake can resume that seat's
// session and restore its ratified workRoot + dedicated env instead of a fresh
// launch. Writing the record is a separate concern and lives elsewhere.

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Engines whose captured session this reader knows how to resume. A record for
 *  any other engine is well-formed but not resumable — callers must fall through
 *  to a normal wake rather than start creating panes for it. */
export function isResumableEngine(engine: string): boolean {
  const normalized = engine.toLowerCase();
  return normalized === "codex" || normalized === "claude";
}

/** A launch binding is valid when every present field is well-formed. Absent
 *  (undefined) is valid — legacy windows simply have no binding. */
export function isValidLaunchBinding(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const launch = value as Record<string, unknown>;
  if (launch.cwd !== undefined
    && (typeof launch.cwd !== "string" || !launch.cwd.startsWith("/"))) return false;
  if (launch.env !== undefined) {
    if (!launch.env || typeof launch.env !== "object" || Array.isArray(launch.env)) return false;
    for (const [key, val] of Object.entries(launch.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== "string") return false;
    }
  }
  if (launch.argv !== undefined
    && (!Array.isArray(launch.argv)
      || launch.argv.length === 0
      || launch.argv.some((word) => typeof word !== "string" || word.length === 0))) return false;
  return true;
}

/** True only when the record carries everything needed to resume the session.
 *  A partial or absent record is not recoverable — callers fall through to a
 *  normal fresh wake rather than guessing. */
export function isFleetRuntimeIdentity(value: unknown): value is FleetRuntimeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const runtime = value as Partial<FleetRuntimeIdentity>;
  return typeof runtime.engine === "string"
    && /^[A-Za-z0-9_.:-]+$/.test(runtime.engine)
    && typeof runtime.cwd === "string"
    && runtime.cwd.startsWith("/")
    && typeof runtime.nativeSessionId === "string"
    && runtime.nativeSessionId.trim().length > 0
    && typeof runtime.capturedAt === "string"
    && Number.isFinite(Date.parse(runtime.capturedAt))
    && isValidLaunchBinding(runtime.launch);
}

/** Build the shell command that resumes a captured fleet window. When a launch
 *  binding is present its cwd overrides the captured cwd and its env is exported
 *  ahead of the resume command; without one the output is the bare
 *  `cd <cwd> && <engine> resume <id>` (byte-identical to legacy behavior). */
export function buildFleetWindowResumeCommand(
  runtime: FleetRuntimeIdentity,
  prompt?: string,
): string {
  if (!isFleetRuntimeIdentity(runtime)) throw new Error("invalid recoverable runtime identity");
  const engine = runtime.engine.toLowerCase();
  const resume = engine === "codex"
    ? `codex resume ${shellQuote(runtime.nativeSessionId)}`
    : engine === "claude"
      ? `claude --resume ${shellQuote(runtime.nativeSessionId)}`
      : null;
  if (!resume) throw new Error(`unsupported recoverable engine '${runtime.engine}'`);
  const withPrompt = prompt?.trim() ? `${resume} ${shellQuote(prompt.trim())}` : resume;
  const launch = runtime.launch;
  const cwd = launch?.cwd ?? runtime.cwd;
  const envPrefix = launch?.env && Object.keys(launch.env).length > 0
    ? Object.entries(launch.env)
      .map(([key, val]) => `${key}=${shellQuote(val)}`)
      .join(" ") + " "
    : "";
  return `cd ${shellQuote(cwd)} && ${envPrefix}${withPrompt}`;
}
