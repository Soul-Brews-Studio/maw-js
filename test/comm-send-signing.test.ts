import { describe, expect, test } from "bun:test";
import { formatSignedMessage, parseSenderOverride, resolveSenderIdentity } from "../src/commands/shared/comm-send";

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


describe("sender identity overrides (#1889)", () => {
  test("parses user-facing node:oracle and derives wire oracle:node", () => {
    expect(parseSenderOverride("alpha:volt-oracle")).toEqual({
      node: "alpha",
      oracle: "volt-oracle",
      display: "alpha:volt-oracle",
      wireFrom: "volt-oracle:alpha",
      senderName: "volt-oracle",
    });
  });

  test("rejects malformed sender overrides", () => {
    expect(parseSenderOverride("alpha")).toBeNull();
    expect(parseSenderOverride("alpha:volt:extra")).toBeNull();
    expect(parseSenderOverride("alpha:bad/oracle")).toBeNull();
  });

  test("CLI --from wins over MAW_SENDER and SSH relay env", () => {
    const identity = resolveSenderIdentity(
      { node: "m5", oracle: "mawjs" } as never,
      { from: "alpha:volt-oracle" },
      { MAW_SENDER: "beta:other-oracle", SSH_CONNECTION: "1 2 3 4" } as NodeJS.ProcessEnv,
    );

    expect(identity).toMatchObject({
      source: "flag",
      node: "alpha",
      oracle: "volt-oracle",
      display: "alpha:volt-oracle",
      wireFrom: "volt-oracle:alpha",
    });
  });

  test("MAW_SENDER allows SSH relay wrappers without local impersonation", () => {
    const identity = resolveSenderIdentity(
      { node: "m5", oracle: "mawjs" } as never,
      {},
      { MAW_SENDER: "alpha:volt-oracle", SSH_CLIENT: "10.0.0.7 123 22" } as NodeJS.ProcessEnv,
    );

    expect(identity.source).toBe("env");
    expect(identity.display).toBe("alpha:volt-oracle");
    expect(identity.wireFrom).toBe("volt-oracle:alpha");
  });

  test("SSH relay without explicit sender refuses to stamp local identity", () => {
    expect(() => resolveSenderIdentity(
      { node: "m5", oracle: "mawjs" } as never,
      {},
      { SSH_CONNECTION: "10.0.0.7 123 10.0.0.8 22" } as NodeJS.ProcessEnv,
    )).toThrow("SSH-relayed");
  });
});
