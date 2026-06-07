/** Extra isolated coverage for wake-resolve-scan-suggest edge branches. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetAllowedOrgsCache,
  readTtyAnswer,
  scanSuggestOracle,
} from "../../src/commands/shared/wake-resolve-scan-suggest";

const originalLog = console.log;
const originalError = console.error;
const originalStdoutWrite = process.stdout.write;
const originalExit = process.exit;

let logs: string[] = [];
let errors: string[] = [];
let writes: string[] = [];

function resetOutput(): void {
  logs = [];
  errors = [];
  writes = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
}

beforeEach(() => {
  _resetAllowedOrgsCache();
  resetOutput();
  process.exit = originalExit;
});

afterEach(() => {
  _resetAllowedOrgsCache();
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalStdoutWrite;
  process.exit = originalExit;
});

describe("readTtyAnswer final-empty branch", () => {
  test("returns null after three whitespace-only tty reads", () => {
    const reads = [
      { ok: true as const, text: "\n", n: 1 },
      { ok: true as const, text: "  \n", n: 3 },
      { ok: true as const, text: "\t", n: 1 },
    ];
    let index = 0;

    expect(readTtyAnswer(() => reads[index++] ?? { ok: false })).toBeNull();
    expect(index).toBe(3);
  });
});

describe("scanSuggestOracle remaining prompt and failure branches", () => {
  test("fails softly when gh is unavailable", async () => {
    const result = await scanSuggestOracle("ghost", {
      execFn: () => {
        throw new Error("gh unavailable");
      },
      configFn: () => ({}),
      hostExecFn: async () => {
        throw new Error("host exec should not run after gh failure");
      },
    });

    expect(result).toBeNull();
  });

  test("reports an empty org plan before prompting", async () => {
    const result = await scanSuggestOracle("quiet", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return " \n";
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => {
        throw new Error("prompt should not run with no orgs");
      },
      configFn: () => ({}),
      hostExecFn: async () => {
        throw new Error("host exec should not run with no orgs");
      },
    });

    expect(result).toBeNull();
    expect(errors.some((line) => line.includes("no orgs configured"))).toBe(true);
  });

  test("stops when the owned/member org filter removes every local org", async () => {
    const result = await scanSuggestOracle("quiet", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/unowned/example\n";
        if (cmd.startsWith("gh api user --jq")) return "nat\n";
        if (cmd.startsWith("gh api user/orgs")) return "shared\n";
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => {
        throw new Error("prompt should not run when filter removes all orgs");
      },
      configFn: () => ({}),
      hostExecFn: async () => {
        throw new Error("host exec should not run when filter removes all orgs");
      },
    });

    expect(result).toBeNull();
    expect(errors.some((line) => line.includes("no locally-cloned orgs are owned"))).toBe(true);
  });

  test("default prompt bails out non-interactively without scanning", async () => {
    const repoViews: string[] = [];

    const result = await scanSuggestOracle("sprite", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/team/seed\n";
        if (cmd.startsWith("gh repo view ")) {
          repoViews.push(cmd);
          throw new Error("default prompt should prevent scanning in tests");
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      configFn: () => ({}),
      allLocal: true,
      hostExecFn: async () => {
        throw new Error("host exec should not run without scan consent");
      },
    });

    expect(result).toBeNull();
    expect(repoViews).toEqual([]);
    expect(writes).toContain("Scan now? [y/N] ");
    expect(logs.some((line) => line.includes("non-interactive"))).toBe(true);
  });

  test("explicit prompt rejection exits with the documented abort path", async () => {
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;

    await expect(scanSuggestOracle("sprite", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/team/seed\n";
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => false,
      configFn: () => ({}),
      allLocal: true,
      hostExecFn: async () => {
        throw new Error("host exec should not run after abort");
      },
    })).rejects.toThrow("exit:0");

    expect(logs.some((line) => line.includes("aborted. Manually"))).toBe(true);
  });

  test("clone failures are warnings and missing ghq paths return null", async () => {
    const hostCalls: string[] = [];

    const result = await scanSuggestOracle("sprite-oracle", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/team/seed\n";
        if (cmd === "gh repo view 'team/sprite-oracle' --json url 2>/dev/null") {
          return JSON.stringify({ url: "https://github.com/team/sprite-oracle" });
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => true,
      configFn: () => ({}),
      allLocal: true,
      hostExecFn: async (cmd) => {
        hostCalls.push(cmd);
        if (cmd.startsWith("ghq get -u")) throw new Error("network offline");
        if (cmd.startsWith("ghq list --full-path")) return "\n";
        throw new Error(`unexpected host command: ${cmd}`);
      },
    });

    expect(result).toBeNull();
    expect(hostCalls).toEqual([
      "ghq get -u 'https://github.com/team/sprite-oracle'",
      "ghq list --full-path | grep -i '/sprite-oracle$' | head -1",
    ]);
    expect(errors.some((line) => line.includes("clone failed: network offline"))).toBe(true);
    expect(errors.some((line) => line.includes("clone succeeded but path not found"))).toBe(true);
  });
});
