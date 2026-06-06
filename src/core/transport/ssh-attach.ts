export class SshAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshAttachError";
  }
}

export interface AttachRemoteSessionOptions {
  node: string;
  sshAlias: string;
  sessionName: string;
  spawnSync?: typeof Bun.spawnSync;
}

const SAFE_TMUX_SESSION = /^[A-Za-z0-9_.:-]+$/;

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function attachRemoteSession(opts: AttachRemoteSessionOptions): void {
  const { node, sshAlias, sessionName } = opts;
  if (!sshAlias?.trim()) {
    throw new SshAttachError(`cannot attach to ${node}: missing SSH target`);
  }
  if (!SAFE_TMUX_SESSION.test(sessionName)) {
    throw new SshAttachError(`cannot attach to ${node}: unsafe tmux session '${sessionName}'`);
  }

  const spawnSync = opts.spawnSync ?? Bun.spawnSync;
  const remoteCommand = `tmux attach-session -t ${shellArg(sessionName)}`;
  const result = spawnSync(["ssh", "-tt", sshAlias, remoteCommand], {
    stdio: ["inherit", "inherit", "inherit"],
  });

  if (result.exitCode !== 0) {
    throw new SshAttachError(`ssh attach to ${node} (${sshAlias}) failed with exit ${result.exitCode}`);
  }
}
