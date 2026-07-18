import { describe, expect, test } from "bun:test";
import { createSshTransport } from "../../src/core/transport/ssh";

describe("ssh transport windows PATH handling (T-069)", () => {
  test("pathWithCommonLocalBins uses the platform path delimiter", async () => {
    if (process.platform !== "win32") return;

    let capturedPath: string | undefined;
    const transport = createSshTransport({
      env: () => ({ PATH: "C:\\Users\\Test\\bin;C:\\Windows\\System32" }),
      spawn: ((args: string[], opts: any) => {
        capturedPath = opts?.env?.PATH;
        return {
          exited: Promise.resolve(0),
          kill: () => {},
          stdout: new ReadableStream({ start(c) { c.close(); } }),
          stderr: new ReadableStream({ start(c) { c.close(); } }),
        } as any;
      }) as any,
    });

    await transport.hostExec("echo ok");
    expect(capturedPath).toBeDefined();
    // PATH should preserve Windows entries and include common system dirs
    expect(capturedPath).toContain("C:\\Users\\Test\\bin");
    expect(capturedPath).toContain("C:\\Windows\\System32");
    expect(capturedPath).toContain("C:\\Windows");
  });
});
