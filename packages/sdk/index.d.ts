/**
 * @maw-js/sdk — stable typed API for maw-js plugin authors.
 *
 * Hand-authored declaration file. Self-contained — safe to ship
 * through file:, tarball, or npm install with no path dependencies.
 * Mirrors the runtime shape at src/core/runtime/sdk.ts.
 */

// --- Core types (mirror src/lib/schemas.ts) ---

export interface Identity {
  node: string;
  version: string;
  agents: string[];
  clockUtc: string;
  uptime: number;
}

export interface Peer {
  url: string;
  reachable: boolean;
  latency?: number;
  node?: string;
  agents?: string[];
  clockDeltaMs?: number;
  clockWarning?: boolean;
}

export interface FederationStatus {
  localUrl: string;
  peers: Peer[];
  totalPeers: number;
  reachablePeers: number;
  clockHealth?: {
    clockUtc: string;
    timezone: string;
    uptimeSeconds: number;
  };
}

export interface Session {
  name: string;
  source?: string;
  windows: Array<{
    index: number;
    name: string;
    active: boolean;
  }>;
}

export interface FeedEvent {
  timestamp: string;
  oracle: string;
  host: string;
  event: string;
  project: string;
  sessionId: string;
  message: string;
}

export interface PluginInfo {
  name: string;
  type: string;
  source: string;
  loadedAt: string;
  events: number;
  errors: number;
}

// --- Print helpers ---

export interface PrintHelpers {
  header(text: string): void;
  ok(text: string): void;
  warn(text: string): void;
  err(text: string): void;
  dim(text: string): void;
  list(items: string[], dot?: string, color?: string): void;
  kv(key: string, value: string): void;
  table(rows: string[][], header?: string[]): void;
  nl(): void;
}

// --- maw SDK surface ---

export interface MawSdk {
  /** Node identity: name, version, agents, clock. */
  identity(): Promise<Identity>;
  /** Federation status: peers, latency, clock drift. */
  federation(): Promise<FederationStatus>;
  /** Local + federated sessions. */
  sessions(local?: boolean): Promise<Session[]>;
  /** Feed events. */
  feed(limit?: number): Promise<FeedEvent[]>;
  /** Plugin stats. */
  plugins(): Promise<{
    plugins: PluginInfo[];
    totalEvents: number;
    totalErrors: number;
  }>;
  /** Node config (masked). */
  config(): Promise<Record<string, unknown>>;
  /** Wake an oracle. */
  wake(target: string, task?: string): Promise<{ ok: boolean }>;
  /** Sleep an oracle. */
  sleep(target: string): Promise<{ ok: boolean }>;
  /** Send a message to an agent. */
  send(target: string, text: string): Promise<{ ok: boolean }>;
  /** Colored terminal output helpers. */
  print: PrintHelpers;
  /** Base URL of the local maw serve (http://localhost:port). */
  baseUrl(): string;
  /** Typed fetch against maw serve — throws on failure. */
  fetch<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T>;
}

export declare const maw: MawSdk;
export default maw;

// --- tmux SDK surface (#855) ---
// Self-contained mirror of src/core/transport/tmux-class.ts. Hand-authored
// so file:/tarball installs from outside the repo type-check cleanly. Only
// the most-used methods are surfaced — the runtime class has more, but
// this is the stable contract plugin authors can rely on.

export interface TmuxPane {
  id: string;
  command: string;
  target: string;
  title: string;
  pid?: number;
  cwd?: string;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  cwd?: string;
}

export interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
}

export declare class Tmux {
  constructor(host?: string, socket?: string);
  run(subcommand: string, ...args: (string | number)[]): Promise<string>;
  tryRun(subcommand: string, ...args: (string | number)[]): Promise<string>;
  listSessions(): Promise<TmuxSession[]>;
  listAll(): Promise<TmuxSession[]>;
  hasSession(name: string): Promise<boolean>;
  killSession(name: string): Promise<void>;
  listWindows(session: string): Promise<TmuxWindow[]>;
  newWindow(
    session: string,
    name: string,
    opts?: { cwd?: string },
  ): Promise<void>;
  selectWindow(target: string): Promise<void>;
  switchClient(session: string): Promise<void>;
  killWindow(target: string): Promise<void>;
  listPanes(): Promise<TmuxPane[]>;
  killPane(target: string): Promise<void>;
  getPaneCommand(target: string): Promise<string>;
  capture(target: string, lines?: number): Promise<string>;
  sendKeys(target: string, ...keys: string[]): Promise<void>;
  sendKeysLiteral(target: string, text: string): Promise<void>;
  sendText(target: string, text: string): Promise<void>;
}

/** Default tmux instance — use this for the local socket. */
export declare const tmux: Tmux;
