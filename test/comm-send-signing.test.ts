import { describe, expect, test } from "bun:test";
import { formatSignedMessage } from "../src/commands/shared/comm-send";

describe("formatSignedMessage — visible Oracle attribution (#1388)", () => {
  const config = { node: "m5" };

  test("prefixes ordinary federation chat with node and sender", () => {
    expect(formatSignedMessage("hello", config, "mawjs-codex")).toBe("[m5:mawjs-codex] hello");
  });

  test("does not double-prefix already signed messages", () => {
    expect(formatSignedMessage("[m5:mawjs-codex] hello", config, "mawjs-codex"))
      .toBe("[m5:mawjs-codex] hello");
  });

  test("does not prefix slash commands", () => {
    expect(formatSignedMessage("/recap --now", config, "mawjs-codex")).toBe("/recap --now");
  });

  test("does not prefix dollar skill commands", () => {
    expect(formatSignedMessage("$go update", config, "mawjs-codex")).toBe("$go update");
  });

  test("preserves leading whitespace when signing prose", () => {
    expect(formatSignedMessage("  hello", config, "mawjs-codex")).toBe("  [m5:mawjs-codex] hello");
  });
});
