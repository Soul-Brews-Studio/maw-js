/**
 * Unit tests for the shared cross-node SSH-attach helper (#1236 Tier 3 prep).
 *
 * We inject a fake `exec` to avoid actually shelling out to ssh, and assert:
 *   - the helper builds the right ssh argv
 *   - failure classification maps stderr/exit to the right SshAttachErrorKind
 *   - the formatted message matches the design-doc §5 error UX
 *   - unsafe session names are rejected before any exec
 */
import { describe, test, expect } from "bun:test";
import {
  attachRemoteSession,
  SshAttachError,
  type ExecFileSyncFn,
} from "../src/core/transport/ssh-attach";

function makeFakeExec(thrown?: { status?: number; message?: string; stderr?: string }): {
  exec: ExecFileSyncFn;
  calls: Array<{ file: string; args: readonly string[] }>;
} {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const exec: ExecFileSyncFn = (file, args) => {
    calls.push({ file, args });
    if (thrown) {
      const e: any = new Error(thrown.message ?? "exec failed");
      if (thrown.status != null) e.status = thrown.status;
      if (thrown.stderr != null) e.stderr = thrown.stderr;
      throw e;
    }
    return Buffer.alloc(0);
  };
  return { exec, calls };
}

describe("attachRemoteSession", () => {
  test("happy path — builds `ssh -tt <alias> 'tmux attach-session -t <name>'`", () => {
    const { exec, calls } = makeFakeExec();
    attachRemoteSession({
      node: "mba",
      sshAlias: "mba.wg",
      sessionName: "24-homekeeper",
      exec,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].file).toBe("ssh");
    expect(calls[0].args[0]).toBe("-tt");
    expect(calls[0].args[1]).toBe("mba.wg");
    expect(String(calls[0].args[2])).toContain("attach-session -t '24-homekeeper'");
  });

  test("ssh exit 255 + Connection refused → kind=unreachable, friendly message", () => {
    const { exec } = makeFakeExec({
      status: 255,
      message: "Command failed: ssh -tt mba.wg",
      stderr: "ssh: connect to host mba.wg port 22: Connection refused\r\n",
    });
    try {
      attachRemoteSession({ node: "mba", sshAlias: "mba.wg", sessionName: "homekeeper", exec });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SshAttachError);
      const e = err as SshAttachError;
      expect(e.kind).toBe("unreachable");
      expect(e.exitCode).toBe(255);
      expect(e.message).toContain("can't reach mba");
      expect(e.message).toContain("ssh mba.wg");
    }
  });

  test("ssh exit 255 + Permission denied (publickey) → kind=auth-failed", () => {
    const { exec } = makeFakeExec({
      status: 255,
      message: "Command failed",
      stderr: "mba.wg: Permission denied (publickey).\r\n",
    });
    try {
      attachRemoteSession({ node: "mba", sshAlias: "mba.wg", sessionName: "homekeeper", exec });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SshAttachError);
      const e = err as SshAttachError;
      expect(e.kind).toBe("auth-failed");
      expect(e.message).toContain("no SSH key for mba");
    }
  });

  test("remote tmux missing → kind=tmux-missing", () => {
    const { exec } = makeFakeExec({
      status: 127,
      message: "Command failed",
      stderr: "bash: tmux: command not found\r\n",
    });
    try {
      attachRemoteSession({ node: "mba", sshAlias: "mba.wg", sessionName: "homekeeper", exec });
      throw new Error("expected throw");
    } catch (err) {
      const e = err as SshAttachError;
      expect(e.kind).toBe("tmux-missing");
      expect(e.message).toContain("tmux not installed on mba");
    }
  });

  test("remote session missing → kind=session-missing", () => {
    const { exec } = makeFakeExec({
      status: 1,
      message: "Command failed",
      stderr: "can't find session: homekeeper\r\n",
    });
    try {
      attachRemoteSession({ node: "mba", sshAlias: "mba.wg", sessionName: "homekeeper", exec });
      throw new Error("expected throw");
    } catch (err) {
      const e = err as SshAttachError;
      expect(e.kind).toBe("session-missing");
      expect(e.message).toContain("session 'homekeeper'");
    }
  });

  test("unsafe session name is rejected BEFORE exec", () => {
    const { exec, calls } = makeFakeExec();
    try {
      attachRemoteSession({
        node: "mba",
        sshAlias: "mba.wg",
        // Shell-meaningful chars; must be refused at the helper boundary.
        sessionName: "bad;rm -rf /",
        exec,
      });
      throw new Error("expected throw");
    } catch (err) {
      const e = err as SshAttachError;
      expect(e.kind).toBe("unsafe-name");
      expect(calls.length).toBe(0);
    }
  });

  test("Buffer stderr is decoded for classification", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec: ExecFileSyncFn = (file, args) => {
      calls.push({ file, args });
      const e: any = new Error("Command failed");
      e.status = 255;
      e.stderr = Buffer.from("Permission denied (publickey).\n", "utf-8");
      throw e;
    };
    try {
      attachRemoteSession({ node: "mba", sshAlias: "mba.wg", sessionName: "ok-name", exec });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as SshAttachError).kind).toBe("auth-failed");
    }
  });
});
