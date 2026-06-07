import { Tmux } from "maw-js/sdk";

export const STREAM_USAGE = "usage: maw stream <session>:<win> [--into <session>] [--name <alias>] | maw stream --unlink <session>:<alias>";

export interface StreamOptions {
  into?: string;
  name?: string;
  unlink?: boolean;
}

export interface StreamResult {
  source?: string;
  into: string;
  name: string;
  target: string;
  createdDestination?: boolean;
  renamedSharedWindow?: boolean;
  unlinked?: boolean;
}

interface StreamWindow {
  index: number;
  name: string;
}

interface StreamTmux {
  hasSession(name: string): Promise<boolean>;
  listWindows(session: string): Promise<StreamWindow[]>;
  newSession(name: string, opts?: { window?: string; detached?: boolean }): Promise<string>;
  killSession(name: string): Promise<void>;
  killWindow(target: string): Promise<void>;
  linkWindow(source: string, target: string, opts?: { detached?: boolean }): Promise<void>;
  unlinkWindow(target: string, opts?: { killLastLink?: boolean }): Promise<void>;
  renameWindow(target: string, name: string): Promise<void>;
  setWindowOption(target: string, option: string, value: string): Promise<void>;
  run(subcommand: string, ...args: (string | number)[]): Promise<string>;
}

export interface StreamDeps {
  tmux: StreamTmux;
  stdoutWrite: (chunk: string) => void;
}

export function streamDeps(overrides: Partial<StreamDeps> = {}): StreamDeps {
  return {
    tmux: new Tmux() as unknown as StreamTmux,
    stdoutWrite: (chunk) => { process.stdout.write(chunk); },
    ...overrides,
  };
}

const PLACEHOLDER_WINDOW = "maw-stream-placeholder";

function assertName(kind: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || trimmed.includes(":")) {
    throw new Error(`stream: invalid ${kind}: ${value || "(empty)"}`);
  }
  return trimmed;
}

function parseWindowTarget(target: string): { session: string; window: string } {
  const raw = target.trim();
  if (!raw || raw.startsWith("-")) throw new Error(STREAM_USAGE);
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) {
    throw new Error("stream: target must be <session>:<window>");
  }
  const session = raw.slice(0, colon).trim();
  const window = raw.slice(colon + 1).trim();
  if (!session || !window) throw new Error("stream: target must be <session>:<window>");
  if (/\.\d+$/.test(window)) throw new Error("stream: target must be a tmux window, not a pane");
  return { session, window };
}

function nextWindowIndex(windows: StreamWindow[], baseIndex = 0): number {
  const used = new Set(windows.map(w => w.index));
  for (let i = baseIndex; i < 10_000; i += 1) {
    if (!used.has(i)) return i;
  }
  throw new Error("stream: no free destination window index found");
}

async function destinationBaseIndex(session: string, deps: StreamDeps): Promise<number> {
  try {
    const raw = await deps.tmux.run("show-options", "-t", session, "-gv", "base-index");
    const value = Number(raw.trim());
    if (Number.isInteger(value) && value >= 0) return value;
  } catch {
    // Fall back to tmux's historical default if the option probe fails.
  }
  return 0;
}

async function resolveSource(target: string, deps: StreamDeps): Promise<{ session: string; index: number; name: string; target: string }> {
  const parsed = parseWindowTarget(target);
  let windows: StreamWindow[];
  try {
    windows = await deps.tmux.listWindows(parsed.session);
  } catch (e: any) {
    throw new Error(`stream: source session '${parsed.session}' not found`);
  }

  const numeric = /^\d+$/.test(parsed.window);
  if (numeric) {
    const index = Number(parsed.window);
    const match = windows.find(w => w.index === index);
    if (!match) throw new Error(`stream: source window '${parsed.session}:${parsed.window}' not found`);
    return { session: parsed.session, index: match.index, name: match.name, target: `${parsed.session}:${match.index}` };
  }

  const exact = windows.filter(w => w.name === parsed.window);
  if (exact.length > 1) {
    const choices = exact.map(w => `${parsed.session}:${w.index}`).join(", ");
    throw new Error(`stream: source window '${parsed.session}:${parsed.window}' is ambiguous; use one of: ${choices}`);
  }
  if (exact.length === 0) {
    const available = windows.map(w => `${w.index}:${w.name}`).join(", ") || "(none)";
    throw new Error(`stream: source window '${parsed.session}:${parsed.window}' not found; windows: ${available}`);
  }
  const match = exact[0];
  return { session: parsed.session, index: match.index, name: match.name, target: `${parsed.session}:${match.index}` };
}

async function currentSession(deps: StreamDeps): Promise<string> {
  try {
    const raw = await deps.tmux.run("display-message", "-p", "#{session_name}");
    const session = raw.trim();
    if (session) return session;
  } catch {
    // Fall through to the clearer user-facing error below.
  }
  throw new Error("stream: --into is required outside tmux");
}

async function destinationSession(opts: StreamOptions, deps: StreamDeps): Promise<{ name: string; autoCreate: boolean }> {
  if (opts.into) return { name: assertName("destination session", opts.into), autoCreate: false };
  const current = await currentSession(deps);
  return { name: current.endsWith("-view") ? current : `${current}-view`, autoCreate: true };
}

async function ensureDestination(dest: string, autoCreate: boolean, deps: StreamDeps): Promise<{ created: boolean; placeholder?: string }> {
  if (await deps.tmux.hasSession(dest)) return { created: false };
  if (!autoCreate) throw new Error(`stream: destination session '${dest}' not found`);
  await deps.tmux.newSession(dest, { window: PLACEHOLDER_WINDOW, detached: true });
  const windows = await deps.tmux.listWindows(dest);
  const placeholder = windows.find(w => w.name === PLACEHOLDER_WINDOW);
  return { created: true, placeholder: placeholder ? `${dest}:${placeholder.index}` : undefined };
}

async function tmuxServerPid(target: string, deps: StreamDeps): Promise<string> {
  const raw = await deps.tmux.run("display-message", "-t", target, "-p", "#{pid}");
  const pid = raw.trim();
  if (!pid) throw new Error(`stream: could not resolve tmux server for '${target}'`);
  return pid;
}

async function assertSameServer(sourceTarget: string, destinationSessionName: string, deps: StreamDeps): Promise<void> {
  const sourcePid = await tmuxServerPid(sourceTarget, deps);
  const destPid = await tmuxServerPid(`${destinationSessionName}:`, deps);
  if (sourcePid !== destPid) {
    throw new Error("stream: source and destination must be on the same tmux server");
  }
}

async function linkStream(target: string, opts: StreamOptions, deps: StreamDeps): Promise<StreamResult> {
  const source = await resolveSource(target, deps);
  const destination = await destinationSession(opts, deps);
  if (destination.name === source.session) {
    throw new Error("stream: destination session must differ from source session");
  }

  const alias = assertName("window alias", opts.name ?? source.name);
  let createdDestination = false;
  try {
    const ensured = await ensureDestination(destination.name, destination.autoCreate, deps);
    createdDestination = ensured.created;
    const before = await deps.tmux.listWindows(destination.name);
    await assertSameServer(source.target, destination.name, deps);
    if (before.some(w => w.name === alias)) {
      const hint = opts.name ? "choose a different --name" : "use --name <alias>";
      throw new Error(`stream: destination window '${destination.name}:${alias}' already exists; ${hint}`);
    }

    const index = nextWindowIndex(before, await destinationBaseIndex(destination.name, deps));
    const destinationTarget = `${destination.name}:${index}`;
    await deps.tmux.linkWindow(source.target, destinationTarget, { detached: true });
    if (alias !== source.name) await deps.tmux.renameWindow(destinationTarget, alias);
    await deps.tmux.setWindowOption(destinationTarget, "@maw-linked-from", source.target);
    if (ensured.placeholder) await deps.tmux.killWindow(ensured.placeholder);
    return {
      source: source.target,
      into: destination.name,
      name: alias,
      target: `${destination.name}:${alias}`,
      createdDestination,
      renamedSharedWindow: alias !== source.name,
    };
  } catch (e) {
    if (createdDestination) await deps.tmux.killSession(destination.name);
    throw e;
  }
}

async function unlinkStream(target: string, deps: StreamDeps): Promise<StreamResult> {
  const parsed = parseWindowTarget(target);
  const unlinkTarget = `${parsed.session}:${parsed.window}`;
  await deps.tmux.unlinkWindow(unlinkTarget);
  return {
    into: parsed.session,
    name: parsed.window,
    target: unlinkTarget,
    unlinked: true,
  };
}

function formatResult(result: StreamResult): string {
  if (result.unlinked) return `stream: unlinked ${result.target}\n`;
  const created = result.createdDestination ? " (created destination)" : "";
  const renamed = result.renamedSharedWindow ? " (renamed shared window)" : "";
  return `stream: linked ${result.source} -> ${result.target}${created}${renamed}\n`;
}

export async function cmdStream(target: string, opts: StreamOptions = {}, overrides: Partial<StreamDeps> = {}): Promise<StreamResult> {
  const deps = streamDeps(overrides);
  const result = opts.unlink ? await unlinkStream(target, deps) : await linkStream(target, opts, deps);
  deps.stdoutWrite(formatResult(result));
  return result;
}
