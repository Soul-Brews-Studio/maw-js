import { describe, expect, test } from "bun:test";

describe("ssh transport helper coverage", () => {
  test("hostExec reports local failures with transport metadata and agent command config matching", async () => {
    const { createSshTransport, HostExecError } = await import("../../src/core/transport/ssh.ts");
    const spawned: unknown[][] = [];
    const transport = createSshTransport({
      env: () => ({} as any),
      loadConfig: () => ({ host: "remote", commands: { custom: "agentx --flag" } } as any),
      requireConfig: () => ({ loadConfig: () => ({ commands: { custom: "agentx --flag", ignored: "default" } }) as any }),
      createTmux: () => ({
        listSessions: async () => [],
        capture: async () => "",
        selectWindow: async () => {},
        getPaneCommand: async () => "",
        getPaneCommands: async () => ({}),
        getPaneInfos: async () => ({}),
        exitModeIfNeeded: async () => {},
        sendKeys: async () => {},
        sendKeysLiteral: async () => {},
        sendText: async () => {},
      } as any),
      tmuxCmd: () => "tmux",
      spawn: ((args: string[]) => {
        spawned.push(args);
        return { stdout: new Response("").body!, stderr: new Response("boom").body!, exited: Promise.resolve(7) };
      }) as any,
    });

    try {
      await transport.hostExec("echo hi", "local");
      throw new Error("expected hostExec to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HostExecError);
      expect((error as InstanceType<typeof HostExecError>).target).toBe("local");
      expect((error as InstanceType<typeof HostExecError>).transport).toBe("local");
      expect((error as InstanceType<typeof HostExecError>).exitCode).toBe(7);
      expect((error as Error).message).toContain("[local:local] boom");
    }

    expect(spawned[0]).toEqual(["bash", "-c", "echo hi"]);
    expect(transport.isAgentCommand("agentx")).toBe(true);
    expect(transport.isAgentCommand("node-red")).toBe(false);
    expect(transport.isAgentCommand("2.1.121")).toBe(true);
    expect(transport.isAgentCommand(undefined)).toBe(false);
  });
});
