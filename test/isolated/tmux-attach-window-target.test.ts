import { afterEach, describe, expect, test } from "bun:test";
import { cmdTmuxAttach, _tty } from "../../src/commands/plugins/tmux/impl";

const OLD_TMUX = process.env.TMUX;
const OLD_TTY = _tty.isStdoutTTY;

const encode = (text: string) => new TextEncoder().encode(text);
const spawnOk = (stdout = "") => ({ exitCode: 0, stdout: encode(stdout), stderr: new Uint8Array(), success: true });

afterEach(() => {
  if (OLD_TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = OLD_TMUX;
  _tty.isStdoutTTY = OLD_TTY;
});

function withMockTmux(aliveSessions: string[], fn: (calls: any[]) => void) {
  const origSpawnSync = Bun.spawnSync;
  const calls: any[] = [];
  (Bun as any).spawnSync = ((args: any, opts: any) => {
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return spawnOk(aliveSessions.length ? `${aliveSessions.join("\n")}\n` : "");
    }
    calls.push({ args, opts });
    return spawnOk();
  }) as any;
  try {
    fn(calls);
  } finally {
    (Bun as any).spawnSync = origSpawnSync;
  }
}

describe("cmdTmuxAttach window target preservation (#1982)", () => {
  test("inside tmux switches to session:window instead of bare session", () => {
    _tty.isStdoutTTY = () => true;
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";

    withMockTmux(["01-yd-patient-flow"], (calls) => {
      cmdTmuxAttach("01-yd-patient-flow:yd-patient-flow-oracle");

      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual([
        "tmux",
        "switch-client",
        "-t",
        "01-yd-patient-flow:yd-patient-flow-oracle",
      ]);
    });
  });

  test("print mode shows the preserved session:window attach command", () => {
    _tty.isStdoutTTY = () => false;
    delete process.env.TMUX;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      withMockTmux(["01-yd-patient-flow"], (calls) => {
        cmdTmuxAttach("01-yd-patient-flow:yd-patient-flow-oracle", { print: true });

        expect(calls).toEqual([]);
      });
    } finally {
      console.log = origLog;
    }

    expect(logs.join("\n")).toContain("tmux attach -t 01-yd-patient-flow:yd-patient-flow-oracle");
    expect(logs.join("\n")).toContain("resolved: 01-yd-patient-flow:yd-patient-flow-oracle → 01-yd-patient-flow:yd-patient-flow-oracle");
  });
});
