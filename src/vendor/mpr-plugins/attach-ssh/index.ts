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
}

export default {
  async execute(target: Tier3Target, opts: ExecuteOpts = {}): Promise<void> {
    const ssh = opts.ssh ?? attachRemoteSession;
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
