import { beforeEach, describe, expect, test } from "bun:test";
import {
  classifySnapshots,
  collectFollowSnapshot,
  collectPeekSnapshot,
  cmdActivity,
  formatActivityHuman,
  isStuckSnapshot,
  normalizeSnapshot,
  parseActivityOptions,
  sampleActivity,
  sampleAllActivity,
  type ActivityDeps,
} from "../../src/vendor/mpr-plugins/activity/impl.ts?activity-impl-coverage";

type Session = { name: string; windows: Array<{ index: number; name: string }> };
type FleetEntry = { file: string; path: string; num: number; groupName: string; session: { name: string; windows: Array<{ name: string; repo: string }> } };
type TimerHandle = { fn: () => void; active: boolean; ms?: number };

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let socketScript: ((ws: FakeWebSocket) => void) | null = null;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  binaryType?: BinaryType;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
      socketScript?.(this);
    });
  }

  message(data: unknown) {
    this.onmessage?.({ data });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

let sessions: Session[];
let fleetEntries: FleetEntry[];
let snapshots: string[];
let captures: Array<{ target: string; lines: number | undefined }>;
let out: string[];
let err: string[];
let now: number;
let timers: TimerHandle[];
let handlers: Partial<Record<"SIGINT" | "SIGTERM", () => void>>;

function deps(overrides: Partial<ActivityDeps> = {}): Partial<ActivityDeps> {
  return {
    WebSocketCtor: FakeWebSocket as unknown as ActivityDeps["WebSocketCtor"],
    capture: (async (target: string, lines?: number) => {
      captures.push({ target, lines });
      if (target.includes("ghost-pane")) throw new Error("no such pane");
      return snapshots.shift() ?? "";
    }) as ActivityDeps["capture"],
    findWindow: ((list: any, query: string) => {
      const [sessionName, windowName] = query.split(":", 2);
      const session = list.find((s: Session) => s.name === sessionName);
      const window = session?.windows.find(w => w.name === windowName);
      return window ? `${session.name}:${window.index}` : null;
    }) as ActivityDeps["findWindow"],
    loadConfig: (() => ({ port: 4567 })) as ActivityDeps["loadConfig"],
    listSessions: async () => sessions as any,
    loadFleet: (() => []) as ActivityDeps["loadFleet"],
    loadFleetEntries: (() => fleetEntries as any) as ActivityDeps["loadFleetEntries"],
    stdoutWrite: (chunk) => { out.push(chunk); },
    stderrWrite: (chunk) => { err.push(chunk); },
    now: () => now,
    setTimeout: ((fn: () => void, ms?: number) => {
      const timer = { fn, active: true, ms };
      timers.push(timer);
      return timer as any;
    }) as typeof setTimeout,
    clearTimeout: ((timer: TimerHandle | null) => {
      if (timer) timer.active = false;
    }) as typeof clearTimeout,
    sleep: async (ms) => { now += ms; },
    processOn: (signal, handler) => { handlers[signal] = handler; },
    processOff: (signal, handler) => {
      if (handlers[signal] === handler) delete handlers[signal];
    },
    snapshotSettleMs: 0,
    snapshotTimeoutMs: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  socketScript = null;
  sessions = [{ name: "50-mawjs", windows: [{ index: 1, name: "mawjs-features" }] }];
  fleetEntries = [
    { file: "50-mawjs.json", path: "/fleet/50-mawjs.json", num: 50, groupName: "mawjs", session: { name: "50-mawjs", windows: [{ name: "mawjs-features", repo: "Soul-Brews-Studio/maw-js" }] } },
  ];
  snapshots = [];
  captures = [];
  out = [];
  err = [];
  now = 1_000_000;
  timers = [];
  handlers = {};
});

describe("maw activity impl", () => {
  test("parses duration and sample options with validation", () => {
    expect(parseActivityOptions({ window: "1m30s", samples: 5, sampler: "follow" })).toEqual({ windowMs: 90_000, samples: 5, sampler: "follow" });
    expect(parseActivityOptions({})).toEqual({ windowMs: 30_000, samples: 3, sampler: "peek" });
    expect(() => parseActivityOptions({ window: "nope" })).toThrow("invalid --window");
    expect(() => parseActivityOptions({ samples: 1 })).toThrow("--samples");
    expect(() => parseActivityOptions({ samples: 51 })).toThrow("--samples");
    expect(() => parseActivityOptions({ sampler: "other" })).toThrow("--sampler");
  });

  test("classifies busy, idle, and stuck snapshots", () => {
    expect(normalizeSnapshot("\u001b[31mhello\u001b[0m\r\n")).toBe("hello");
    expect(isStuckSnapshot("\n› ")).toBe(true);

    const busy = classifySnapshots("pane", [
      { text: "one", at: 1_000 },
      { text: "two", at: 2_000 },
      { text: "three", at: 3_000 },
    ], 30_000);
    expect(busy).toMatchObject({ state: "busy", confidence: "high", diff_samples: 3, samples: 3 });

    const idle = classifySnapshots("pane", [
      { text: "same", at: 1_000 },
      { text: "same", at: 16_000 },
      { text: "same", at: 31_000 },
    ], 30_000);
    expect(idle).toMatchObject({ state: "idle", diff_samples: 0, last_change_ago_seconds: 30 });

    const stuck = classifySnapshots("pane", [
      { text: "\n❯ ", at: 1_000 },
      { text: "\n❯ ", at: 31_000 },
    ], 30_000);
    expect(stuck).toMatchObject({ state: "stuck", confidence: "medium", diff_samples: 0 });
    expect(formatActivityHuman(stuck)).toContain("STUCK (at prompt (no change in 30s), 0/2 samples diff)");

    const shortIdle = classifySnapshots("pane", [
      { text: "same", at: 1_000 },
      { text: "same", at: 1_100 },
    ], 100);
    expect(shortIdle).toMatchObject({ state: "idle", sample_window_seconds: 0.1, last_change_ago_seconds: 0.1 });
    expect(formatActivityHuman(shortIdle)).toContain("IDLE (quiet (no change in 0.1s), 0/2 samples diff)");
  });

  test("samples a pane through peek target resolution by default", async () => {
    snapshots = ["one", "two", "three"];

    const result = await sampleActivity("mawjs-features", { window: "2s", samples: 3 }, deps());

    expect(result).toMatchObject({
      pane: "50-mawjs:mawjs-features",
      state: "busy",
      diff_samples: 3,
      sample_window_seconds: 2,
    });
    expect(captures).toEqual([
      { target: "50-mawjs:1", lines: 80 },
      { target: "50-mawjs:1", lines: 80 },
      { target: "50-mawjs:1", lines: 80 },
    ]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test("can still sample through follow when explicitly requested", async () => {
    snapshots = ["one", "two"];

    const result = await sampleActivity("mawjs-features", { window: "1s", samples: 2, sampler: "follow" }, deps({
      followSnapshotPane: async () => snapshots.shift() ?? "",
    }));

    expect(result).toMatchObject({
      pane: "50-mawjs:mawjs-features",
      state: "busy",
      diff_samples: 2,
    });
    expect(captures).toEqual([]);
  });

  test("surveys fleet targets and skips unresolved panes", async () => {
    fleetEntries = [
      { file: "50-mawjs.json", path: "/fleet/50-mawjs.json", num: 50, groupName: "mawjs", session: { name: "50-mawjs", windows: [{ name: "mawjs-features", repo: "Soul-Brews-Studio/maw-js" }, { name: "ghost-pane", repo: "Ghost/repo" }] } },
    ];
    snapshots = ["same", "same"];
    let listSessionCalls = 0;

    const results = await sampleAllActivity({ window: "1s", samples: 2 }, deps({
      listSessions: async () => {
        listSessionCalls += 1;
        return sessions as any;
      },
    }));

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ pane: "50-mawjs:mawjs-features", state: "idle" });
    expect(listSessionCalls).toBe(1);
  });

  test("surveys fleet targets with bounded parallelism", async () => {
    sessions = [{ name: "50-mawjs", windows: [{ index: 1, name: "pane-a" }, { index: 2, name: "pane-b" }] }];
    fleetEntries = [
      { file: "50-mawjs.json", path: "/fleet/50-mawjs.json", num: 50, groupName: "mawjs", session: { name: "50-mawjs", windows: [{ name: "pane-a", repo: "Soul-Brews-Studio/maw-js" }, { name: "pane-b", repo: "Soul-Brews-Studio/maw-js" }] } },
    ];
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await sampleAllActivity({ window: "1s", samples: 2 }, deps({
      allConcurrency: 2,
      snapshotPane: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return "same";
      },
    }));

    expect(results).toHaveLength(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("emits JSON for one-shot and transition-only watch output", async () => {
    snapshots = ["same", "same"];
    await cmdActivity("mawjs-features", { json: true, window: "1s", samples: 2 }, deps());
    expect(JSON.parse(out[0])).toMatchObject({ pane: "50-mawjs:mawjs-features", state: "idle" });

    out = [];
    snapshots = ["idle", "idle", "one", "two", "still", "moving"];
    await cmdActivity("mawjs-features", {
      json: true,
      watch: true,
      watchIterations: 3,
      window: "1s",
      samples: 2,
    }, deps());

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ state: "busy" });
    expect(handlers).toEqual({});
  });

  test("filters one-shot output to stuck panes only", async () => {
    sessions = [{ name: "50-mawjs", windows: [{ index: 1, name: "idle-pane" }, { index: 2, name: "stuck-pane" }] }];
    fleetEntries = [
      { file: "50-mawjs.json", path: "/fleet/50-mawjs.json", num: 50, groupName: "mawjs", session: { name: "50-mawjs", windows: [{ name: "idle-pane", repo: "Soul-Brews-Studio/maw-js" }, { name: "stuck-pane", repo: "Soul-Brews-Studio/maw-js" }] } },
    ];

    const results = await cmdActivity(undefined, {
      all: true,
      json: true,
      stuckOnly: true,
      window: "1s",
      samples: 2,
    }, deps({
      snapshotPane: async (target) => target === "50-mawjs:2" ? "\n❯ " : "same",
    }));

    expect(results.map(result => result.pane)).toEqual(["50-mawjs:stuck-pane"]);
    expect(JSON.parse(out[0])).toMatchObject([{ pane: "50-mawjs:stuck-pane", state: "stuck" }]);
  });

  test("human watch mode redraws a stable current-state table", async () => {
    snapshots = ["same", "same", "same", "same"];

    await cmdActivity("mawjs-features", {
      watch: true,
      watchIterations: 2,
      window: "1s",
      samples: 2,
    }, deps());

    const rendered = out.join("");
    expect(rendered).toContain("activity: watching mawjs-features (window=1s, samples=2, sampler=peek, sampling); press Ctrl-C to stop");
    expect(rendered).toContain("(sampling...)");
    expect(rendered).toContain("activity: watching mawjs-features (window=1s, samples=2, sampler=peek, refresh=1); press Ctrl-C to stop");
    expect(rendered).toContain("50-mawjs:mawjs-features: 🟡 IDLE");
    expect(rendered).toContain("last refresh:");
    expect(rendered).toContain("transitions=0");
    expect(rendered).toContain("\u001b[2A\r\u001b[J");
    expect(err.join("")).not.toContain("transitions only");
  });

  test("human watch footer counts state transitions across refreshes", async () => {
    snapshots = ["same", "same", "one", "two"];

    await cmdActivity("mawjs-features", {
      watch: true,
      watchIterations: 2,
      window: "1s",
      samples: 2,
    }, deps());

    const rendered = out.join("");
    expect(rendered).toContain("transitions=0");
    expect(rendered).toContain("transitions=1");
  });

  test("human fleet watch redraws the whole fleet table in place", async () => {
    snapshots = ["same", "same", "same", "same"];

    await cmdActivity(undefined, {
      all: true,
      watch: true,
      watchIterations: 2,
      window: "1s",
      samples: 2,
    }, deps());

    const rendered = out.join("");
    expect(rendered).toContain("activity: watching fleet (window=1s, samples=2, sampler=peek, sampling); press Ctrl-C to stop");
    expect(rendered).toContain("activity: watching fleet (window=1s, samples=2, sampler=peek, refresh=1); press Ctrl-C to stop");
    expect(rendered).toContain("50-mawjs:mawjs-features: 🟡 IDLE");
    expect(rendered).toContain("watching (window=1s, samples=2, sampler=peek)");
    expect(rendered).toContain("\u001b[2A\r\u001b[J");
  });

  test("human watch with stuck-only redraws an empty red-pane table", async () => {
    snapshots = ["same", "same"];

    await cmdActivity("mawjs-features", {
      stuckOnly: true,
      watch: true,
      watchIterations: 1,
      window: "1s",
      samples: 2,
    }, deps());

    const rendered = out.join("");
    expect(rendered).toContain("(sampling...)");
    expect(rendered).toContain("(no stuck panes)");
    expect(rendered).toContain("last refresh:");
    expect(rendered).not.toContain("IDLE");
  });

  test("collects a bounded snapshot from the follow/PTTY websocket attach protocol", async () => {
    socketScript = (ws) => {
      ws.message(new TextEncoder().encode("hello\n"));
      ws.message(JSON.stringify({ type: "attached" }));
      ws.message("world\n");
      ws.message(JSON.stringify({ type: "detached" }));
    };

    const promise = collectFollowSnapshot("50-mawjs:mawjs-features", 2_000, deps() as ActivityDeps);
    await flush();

    await expect(promise).resolves.toBe("hello\nworld\n");
    expect(FakeWebSocket.instances[0].url).toBe("ws://127.0.0.1:4567/ws/pty");
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toMatchObject({
      type: "attach",
      target: "50-mawjs:mawjs-features",
      replayLines: 2,
    });
  });

  test("collects a peek snapshot through capture without opening a PTY websocket", async () => {
    snapshots = ["latest visible text"];

    await expect(collectPeekSnapshot("50-mawjs:mawjs-features", 2_000, deps() as ActivityDeps)).resolves.toBe("latest visible text");
    expect(captures).toEqual([{ target: "50-mawjs:mawjs-features", lines: 80 }]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
