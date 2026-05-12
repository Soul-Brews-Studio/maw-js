/**
 * Shared SSH-attach helper for cross-node tmux session takeover.
 *
 * Used by:
 *   - plugins/attach (Tier 3 — cross-node attach via aggregated peer sessions)
 *   - plugins/view  (existing host-config-based view attach)
 *
 * Pattern proven in view's `attachViaTmux` (impl.ts:357): `ssh -tt <host>
 * "tmux attach-session -t '<safe>'"`. The remote tmux owns the session;
 * operator's terminal becomes a remote tmux client. Detach (prefix+d) returns
 * cleanly to the local shell. Sizing, copy-mode, and scrollback all work
 * because the remote tmux owns the session — no state-mirroring needed.
 *
 * Failure handling — per cross-node-attach-design §5: this helper NEVER
 * `process.exit`s. Transport failures throw `SshAttachError` so callers can
 * format a one-line UserError and let the CLI catch it. SSH stderr is
 * captured to `err.stderr` for diagnosis.
 */
import { execFileSync } from "child_process";
import { tmuxCmd } from "./tmux";

/** Distinguishes transport failure modes for user-facing error UX. */
export type SshAttachErrorKind =
  | "unreachable"     // ssh exit 255: connection refused / no route / timeout
  | "auth-failed"     // ssh exit 255: permission denied (publickey)
  | "tmux-missing"    // remote: tmux: command not found
  | "session-missing" // remote: tmux can't find session
  | "unsafe-name"     // session name fails safety regex (defensive)
  | "unknown";        // other non-zero exit

export class SshAttachError extends Error {
  readonly node: string;
  readonly sshAlias: string;
  readonly sessionName: string;
  readonly kind: SshAttachErrorKind;
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(opts: {
    node: string;
    sshAlias: string;
    sessionName: string;
    kind: SshAttachErrorKind;
    message: string;
    exitCode?: number;
    stderr?: string;
  }) {
    super(opts.message);
    this.name = "SshAttachError";
    this.node = opts.node;
    this.sshAlias = opts.sshAlias;
    this.sessionName = opts.sessionName;
    this.kind = opts.kind;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
  }
}

/**
 * Defense-in-depth — the remote command is shell-interpreted via `ssh`, so
 * we reject anything outside the tmux-safe character set (matches the same
 * guard in view/impl.ts and peers' isValidPeerSession boundary).
 */
const SAFE_SESSION_NAME = /^[A-Za-z0-9._-]+$/;

/** Test seam — accepts a real `execFileSync` or a stub of the same shape. */
export type ExecFileSyncFn = (
  file: string,
  args: readonly string[],
  options?: { stdio?: unknown },
) => unknown;

export interface AttachRemoteSessionOpts {
  /** Logical node identity (used for error messages, e.g. "mba"). */
  node: string;
  /** SSH host/alias from ~/.ssh/config or wireguard hostname. */
  sshAlias: string;
  /** Remote tmux session name to attach to. */
  sessionName: string;
  /** Optional injection seam for tests. Defaults to child_process execFileSync. */
  exec?: ExecFileSyncFn;
}

/**
 * Hand the TTY over to a remote tmux session via SSH.
 *
 * Blocks (synchronously, via execFileSync) until the user detaches with
 * prefix+d or the remote session ends. Throws `SshAttachError` on transport
 * failures — callers should format and bubble as UserError; do NOT
 * `process.exit` (would take the SSH session with it on nested invocations).
 */
export function attachRemoteSession(opts: AttachRemoteSessionOpts): void {
  const { node, sshAlias, sessionName } = opts;
  const exec = opts.exec ?? (execFileSync as unknown as ExecFileSyncFn);

  if (!SAFE_SESSION_NAME.test(sessionName)) {
    throw new SshAttachError({
      node,
      sshAlias,
      sessionName,
      kind: "unsafe-name",
      message: `refusing ssh attach: unsafe session name '${sessionName}'`,
    });
  }

  const remoteCmd = `${tmuxCmd()} attach-session -t '${sessionName}'`;
  try {
    exec("ssh", ["-tt", sshAlias, remoteCmd], { stdio: "inherit" });
    return;
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; stderr?: unknown };
    const status = typeof e.status === "number" ? e.status : undefined;
    const stderr = decodeStderr(e.stderr);
    const blob = `${e.message ?? ""}\n${stderr ?? ""}`.toLowerCase();
    const kind = classifyFailure(status, blob);
    throw new SshAttachError({
      node,
      sshAlias,
      sessionName,
      kind,
      exitCode: status,
      stderr,
      message: formatMessage({ node, sshAlias, sessionName, kind }),
    });
  }
}

function decodeStderr(s: unknown): string | undefined {
  if (s == null) return undefined;
  try {
    if (typeof s === "string") return s;
    if (s instanceof Uint8Array) return Buffer.from(s).toString("utf-8");
    return String(s);
  } catch {
    return undefined;
  }
}

function classifyFailure(status: number | undefined, blob: string): SshAttachErrorKind {
  // Auth ordering matters: ssh returns 255 for both unreachable AND
  // permission-denied, so we discriminate on the stderr blob first.
  if (blob.includes("permission denied") || blob.includes("publickey")) return "auth-failed";
  if (
    blob.includes("connection refused") ||
    blob.includes("could not resolve") ||
    blob.includes("name or service not known") ||
    blob.includes("no route to host") ||
    blob.includes("connection timed out") ||
    blob.includes("operation timed out") ||
    blob.includes("network is unreachable") ||
    blob.includes("host is down") ||
    blob.includes("connection closed by remote host")
  ) {
    return "unreachable";
  }
  if (blob.includes("command not found") || blob.includes("tmux: not found")) return "tmux-missing";
  if (
    blob.includes("can't find session") ||
    blob.includes("no server running") ||
    blob.includes("no sessions") ||
    blob.includes("session not found")
  ) {
    return "session-missing";
  }
  // ssh's "unable to reach" generic — fall back to unreachable at exit 255.
  if (status === 255) return "unreachable";
  return "unknown";
}

function formatMessage(opts: {
  node: string;
  sshAlias: string;
  sessionName: string;
  kind: SshAttachErrorKind;
}): string {
  const { node, sshAlias, sessionName, kind } = opts;
  switch (kind) {
    case "auth-failed":
      return `✗ no SSH key for ${node} — try: ssh-add ~/.ssh/<your-key> (or check 'ssh ${sshAlias}')`;
    case "unreachable":
      return `✗ can't reach ${node} via ssh — try: ssh ${sshAlias}`;
    case "tmux-missing":
      return `✗ tmux not installed on ${node}`;
    case "session-missing":
      return `✗ session '${sessionName}' is gone on ${node}`;
    case "unsafe-name":
      return `✗ refusing ssh attach: unsafe session name '${sessionName}'`;
    default:
      return `✗ ssh attach to ${node} failed (exit ${"unknown"})`;
  }
}
