/**
 * attach-ssh — Tier 3 (remote-live) SSH+tmux attach strategy.
 *
 * Extracted from plugins/attach (#1262). When `maw attach <name>` resolves
 * to a peer-live session, the dispatcher in plugins/attach/impl.ts scans
 * ~/.maw/plugins/*\/plugin.json for an `attach:strategy` capability matching
 * `strategy.tier === 3` and hands off the resolved target to `execute()`.
 *
 * Keep this small — the friendly console.log lines stay in the host so the
 * UX is consistent even when no strategy plugin is installed (built-in
 * fallback path).
 */
import { attachRemoteSession, SshAttachError } from "maw-js/sdk";
import { spawnSync } from "child_process";

export interface Tier3Target {
  tier: 3;
  sessionName: string;
  node: string;
  peerUrl: string;
  sshAlias: string;
}

export interface ExecuteOpts {
  /** Test seam — swap the SSH helper. Defaults to maw-js/sdk's attachRemoteSession. */
  ssh?: typeof attachRemoteSession;
  /**
   * #1905 — Test seam for the SSH preflight probe.
   * Defaults to a `ssh -o ConnectTimeout=3 -o BatchMode=yes <alias> true` spawn.
   * Returns { ok: true } on success or { ok: false, reason } on failure/timeout.
   */
  probe?: (alias: string, timeoutMs: number) => { ok: boolean; reason?: string };
}

function defaultSshProbe(alias: string, timeoutMs: number): { ok: boolean; reason?: string } {
  // ConnectTimeout=3 lets ssh exit cleanly within ~3s on dead hosts.
  // BatchMode=yes prevents password prompts that would hang the probe.
  // `true` is the cheapest no-op command; only the connection matters.
  const r = spawnSync(
    "ssh",
    ["-o", "ConnectTimeout=3", "-o", "BatchMode=yes", alias, "true"],
    { timeout: timeoutMs, stdio: "ignore" }
  );
  if (r.error) return { ok: false, reason: r.error.message };
  if (r.signal === "SIGTERM") return { ok: false, reason: `probe timed out after ${timeoutMs}ms` };
  return r.status === 0 ? { ok: true } : { ok: false, reason: `ssh exited ${r.status ?? "?"}` };
}

export default {
  async execute(target: Tier3Target, opts: ExecuteOpts = {}): Promise<void> {
    const ssh = opts.ssh ?? attachRemoteSession;
    const probe = opts.probe ?? defaultSshProbe;

    // #1905 — preflight to avoid 14-minute hangs when the SSH alias points
    // at an unreachable host (dead mDNS, wrong subnet, etc.).
    const probeResult = probe(target.sshAlias, 4000);
    if (!probeResult.ok) {
      const msg = [
        `✗ ssh ${target.sshAlias} unreachable in 3s (${probeResult.reason ?? "no response"})`,
        `  • check ~/.ssh/config for 'Host ${target.sshAlias}'`,
        `  • check 'maw peers list' for the routing alias`,
        `  • try the WG hostname directly: ssh ${target.sshAlias}.wg`,
      ].join("\n");
      console.error(msg);
      throw new Error(msg);
    }

    try {
      ssh({
        node: target.node,
        sshAlias: target.sshAlias,
        sessionName: target.sessionName,
      });
    } catch (err) {
      if (err instanceof SshAttachError) {
        // Surface the helper's friendly one-line message — never process.exit.
        console.error(err.message);
        throw new Error(err.message);
      }
      throw err;
    }
  },
};
