import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { cmdLearn, resolveMode } from "../../src/vendor/mpr-plugins/learn/impl";

describe("learn impl coverage", () => {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});

  afterEach(() => {
    logSpy.mockClear();
  });

  test("resolveMode maps flags to documented modes and rejects conflicts", () => {
    expect(resolveMode(false, false)).toBe("default");
    expect(resolveMode(true, false)).toBe("fast");
    expect(resolveMode(false, true)).toBe("deep");
    expect(() => resolveMode(true, true)).toThrow("--fast and --deep are mutually exclusive");
  });

  test("cmdLearn returns and logs mode-specific stub messages", async () => {
    const cases = [
      { mode: "default" as const, agents: "3 parallel" },
      { mode: "fast" as const, agents: "1 parallel" },
      { mode: "deep" as const, agents: "5 parallel" },
    ];

    for (const { mode, agents } of cases) {
      const message = await cmdLearn("Soul-Brews-Studio/maw-js", mode);
      expect(message).toContain(`learn: ${mode} mode on "Soul-Brews-Studio/maw-js"`);
      expect(message).toContain(agents);
      expect(message).toContain("https://github.com/Soul-Brews-Studio/maw-js/issues/521");
      expect(logSpy).toHaveBeenLastCalledWith(message);
    }
  });
});
