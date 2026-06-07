import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

// Intercept all tmux commands the transport issues, with a per-test response
// hook so we can simulate tmux output for the read-after-write round-trip.
let commands: Array<{ cmd: string; time: number }> = [];
let execDelay = 0;
let execResponder: (cmd: string) => string = () => "";

const normalizeTmuxCmd = (cmd: string) =>
  cmd.replace(/^(TERM=xterm tmux) -S '[^']+' /, "$1 ");

const mockExec = async (cmd: string, _host?: string) => {
  const normalized = normalizeTmuxCmd(cmd);
  commands.push({ cmd: normalized, time: Date.now() });
  if (execDelay > 0) await new Promise((r) => setTimeout(r, execDelay));
  return execResponder(normalized);
};

mock.module("../../src/config", () =>
  mockConfigModule(() => ({ host: "local" })),
);
import { mockSshModule } from "../helpers/mock-ssh";
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: mockExec,
  ssh: mockExec,
}));

delete process.env.MAW_TMUX_SOCKET;

const {
  withPaneLock,
  splitWindowLocked,
  tagPane,
  readPaneTags,
} = await import("../../src/core/transport/tmux");

beforeEach(() => {
  delete process.env.MAW_TMUX_SOCKET;
  commands = [];
  execDelay = 0;
  execResponder = () => "";
});

describe("withPaneLock", () => {
  test("serializes concurrent operations end-to-end", async () => {
    const order: string[] = [];
    const make = (tag: string, dur: number) =>
      withPaneLock(async () => {
        order.push(`${tag}-start`);
        await new Promise((r) => setTimeout(r, dur));
        order.push(`${tag}-end`);
      });

    // Fire three concurrently — they should still run one at a time.
    await Promise.all([make("A", 30), make("B", 10), make("C", 5)]);

    expect(order).toEqual([
      "A-start", "A-end",
      "B-start", "B-end",
      "C-start", "C-end",
    ]);
  });

  test("releases lock even when fn throws", async () => {
    await withPaneLock(async () => {
      throw new Error("boom");
    }).catch(() => {});

    let ran = false;
    await withPaneLock(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  test("propagates the fn return value", async () => {
    const v = await withPaneLock(async () => 42);
    expect(v).toBe(42);
  });
});

describe("splitWindowLocked", () => {
  test("issues split-window with -t target and waits settle", async () => {
    const start = Date.now();
    await splitWindowLocked("mawjs:0", { settleMs: 40 });
    const elapsed = Date.now() - start;

    expect(commands).toHaveLength(1);
    expect(commands[0].cmd).toBe("TERM=xterm tmux split-window -t mawjs:0");
    // Allow 5ms jitter on either side of 40ms.
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });

  test("serializes two concurrent splits with settle gap", async () => {
    const p1 = splitWindowLocked("s:0", { settleMs: 50 });
    const p2 = splitWindowLocked("s:1", { settleMs: 10 });
    await Promise.all([p1, p2]);

    expect(commands).toHaveLength(2);
    expect(commands[0].cmd).toBe("TERM=xterm tmux split-window -t s:0");
    expect(commands[1].cmd).toBe("TERM=xterm tmux split-window -t s:1");
    // Second split must start after first's settle window.
    const gap = commands[1].time - commands[0].time;
    expect(gap).toBeGreaterThanOrEqual(45);
  });

  test("passes vertical + pct + shellCommand through to tmux args", async () => {
    await splitWindowLocked("s:0", {
      vertical: true,
      pct: 30,
      shellCommand: "bash",
      settleMs: 0,
    });
    // q() single-quotes `%` since it's outside the safe-char regex.
    expect(commands[0].cmd).toBe("TERM=xterm tmux split-window -t s:0 -v -l '30%' bash");
  });
});

describe("tagPane", () => {
  test("sets title via select-pane -T", async () => {
    await tagPane("s:0.1", { title: "oracle" });
    expect(commands).toEqual([
      { cmd: "TERM=xterm tmux select-pane -t s:0.1 -T oracle", time: expect.any(Number) },
    ]);
  });

  test("sets @meta options (auto-prefixes @)", async () => {
    await tagPane("s:0.1", {
      meta: { "agent-name": "scout", "@role": "teammate" },
    });
    // q() single-quotes `@` since it's outside the safe-char regex.
    expect(commands.map((c) => c.cmd)).toEqual([
      "TERM=xterm tmux set-option -p -t s:0.1 '@agent-name' scout",
      "TERM=xterm tmux set-option -p -t s:0.1 '@role' teammate",
    ]);
  });

  test("quotes values containing spaces", async () => {
    await tagPane("s:0.1", { title: "oracle main" });
    expect(commands[0].cmd).toBe("TERM=xterm tmux select-pane -t s:0.1 -T 'oracle main'");
  });
});

describe("readPaneTags (round-trip)", () => {
  test("reads back title + meta we wrote", async () => {
    // Simulate an in-memory tmux.
    const store: Record<string, { title: string; meta: Record<string, string> }> = {};
    const target = "s:0.1";
    store[target] = { title: "", meta: {} };

    execResponder = (cmd: string) => {
      // select-pane -T <title>
      let m = cmd.match(/^(?:TERM=xterm )?tmux select-pane -t (\S+) -T (?:'((?:[^']|'\\'')*)'|(\S+))$/);
      if (m) {
        const t = m[1];
        const title = m[2] !== undefined ? m[2].replace(/'\\''/g, "'") : m[3]!;
        store[t] = store[t] ?? { title: "", meta: {} };
        store[t].title = title;
        return "";
      }
      // set-option -p -t <target> <@key|'@key'> <val>
      m = cmd.match(/^(?:TERM=xterm )?tmux set-option -p -t (\S+) (?:'(@[^']+)'|(@\S+)) (?:'((?:[^']|'\\'')*)'|(\S+))$/);
      if (m) {
        const t = m[1];
        const key = m[2] ?? m[3]!;
        const val = m[4] !== undefined ? m[4].replace(/'\\''/g, "'") : m[5]!;
        store[t] = store[t] ?? { title: "", meta: {} };
        store[t].meta[key] = val;
        return "";
      }
      // display-message -p -t <target> '#{pane_title}'
      m = cmd.match(/^(?:TERM=xterm )?tmux display-message -p -t (\S+) '#\{pane_title\}'$/);
      if (m) return `${store[m[1]]?.title ?? ""}\n`;
      // show-options -p -t <target>
      m = cmd.match(/^(?:TERM=xterm )?tmux show-options -p -t (\S+)$/);
      if (m) {
        const entries = store[m[1]]?.meta ?? {};
        return Object.entries(entries)
          .map(([k, v]) => `${k} "${v}"`)
          .join("\n");
      }
      return "";
    };

    await tagPane(target, {
      title: "oracle",
      meta: { "agent-name": "scout", role: "teammate" },
    });
    const tags = await readPaneTags(target);

    expect(tags.title).toBe("oracle");
    expect(tags.meta).toEqual({
      "@agent-name": "scout",
      "@role": "teammate",
    });
  });
});
