import { renameSync, writeFileSync } from "node:fs";
import type { FleetEntry, FleetRuntimeIdentity, FleetSession } from "./fleet-load-core";
import { loadFleetEntries } from "./fleet-load-core";

export const FLEET_STATE_SCHEMA_VERSION = 2;

type RuntimeStateDeps = {
  loadFleetEntries?: () => FleetEntry[];
};

export type WriteFleetWindowRuntimeInput = {
  session: string;
  window: string;
  runtime: FleetRuntimeIdentity;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
    && Number.isFinite(Date.parse(runtime.capturedAt));
}

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
  return `cd ${shellQuote(runtime.cwd)} && ${withPrompt}`;
}

export function writeFleetWindowRuntime(
  input: WriteFleetWindowRuntimeInput,
  deps: RuntimeStateDeps = {},
): FleetSession {
  if (!isFleetRuntimeIdentity(input.runtime)) throw new Error("invalid recoverable runtime identity");
  const entries = (deps.loadFleetEntries ?? loadFleetEntries)();
  const matches = entries.filter((entry) =>
    entry.session.name === input.session
    && entry.session.windows.some((window) => window.name === input.window));
  if (matches.length !== 1) {
    throw new Error(`fleet runtime target must resolve exactly once: ${input.session}:${input.window} (found ${matches.length})`);
  }
  const entry = matches[0]!;
  if (!entry.path) throw new Error(`fleet runtime target has no writable path: ${input.session}:${input.window}`);
  const next: FleetSession = {
    ...entry.session,
    schemaVersion: FLEET_STATE_SCHEMA_VERSION,
    windows: entry.session.windows.map((window) =>
      window.name === input.window ? { ...window, runtime: { ...input.runtime } } : window),
  };
  const tmp = `${entry.path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
  renameSync(tmp, entry.path);
  return next;
}
