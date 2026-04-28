/**
 * Tests for src/commands/plugins/init/non-interactive.ts — parseNonInteractive.
 */
import { describe, it, expect } from "bun:test";
import { parseNonInteractive } from "../../src/commands/plugins/init/non-interactive";

const DEFAULTS = { node: "default-node", ghqRoot: "/default/ghq" };
const HOME = "/Users/testuser";

describe("parseNonInteractive", () => {
  it("uses defaults when no flags provided", () => {
    const r = parseNonInteractive([], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.node).toBe("default-node");
      expect(r.opts.ghqRoot).toBe("/default/ghq");
    }
  });

  it("overrides node with --node flag", () => {
    const r = parseNonInteractive(["--node", "custom-node"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.node).toBe("custom-node");
  });

  it("overrides ghqRoot with --ghq-root flag", () => {
    const r = parseNonInteractive(["--ghq-root", "/custom/ghq"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.ghqRoot).toBe("/custom/ghq");
  });

  it("expands tilde in ghq-root", () => {
    const r = parseNonInteractive(["--ghq-root", "~/repos"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.ghqRoot).toBe("/Users/testuser/repos");
  });

  it("parses --token flag", () => {
    const r = parseNonInteractive(["--token", "secret123"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.token).toBe("secret123");
  });

  it("parses --federate flag", () => {
    const r = parseNonInteractive(["--federate"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.federate).toBe(true);
  });

  it("defaults federate to false", () => {
    const r = parseNonInteractive([], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.federate).toBe(false);
  });

  it("auto-enables federate when peers provided", () => {
    const r = parseNonInteractive(["--peer", "http://peer1:3456", "--peer-name", "kc"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.federate).toBe(true);
  });

  it("parses single peer", () => {
    const r = parseNonInteractive(["--peer", "http://peer1:3456", "--peer-name", "kc"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.peers).toHaveLength(1);
      expect(r.opts.peers[0].name).toBe("kc");
      expect(r.opts.peers[0].url).toBe("http://peer1:3456");
    }
  });

  it("auto-names peer when no --peer-name", () => {
    const r = parseNonInteractive(["--peer", "http://peer1:3456"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.peers[0].name).toBe("peer-1");
    }
  });

  it("rejects invalid node name (too long)", () => {
    const longName = "a" + "b".repeat(63); // 64 chars, max is 63
    const r = parseNonInteractive(["--node", longName], HOME, DEFAULTS);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid peer URL", () => {
    const r = parseNonInteractive(["--peer", "not-a-url"], HOME, DEFAULTS);
    expect(r.ok).toBe(false);
  });

  it("rejects overly long peer name", () => {
    const longName = "a" + "b".repeat(31); // 32 chars, max is 31
    const r = parseNonInteractive(["--peer", "http://valid:3456", "--peer-name", longName], HOME, DEFAULTS);
    expect(r.ok).toBe(false);
  });

  it("rejects relative ghq-root", () => {
    const r = parseNonInteractive(["--ghq-root", "relative/path"], HOME, DEFAULTS);
    expect(r.ok).toBe(false);
  });

  it("parses --force flag", () => {
    const r = parseNonInteractive(["--force"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.force).toBe(true);
  });

  it("parses --backup flag", () => {
    const r = parseNonInteractive(["--backup"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.backup).toBe(true);
  });

  it("defaults force and backup to false", () => {
    const r = parseNonInteractive([], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.force).toBe(false);
      expect(r.opts.backup).toBe(false);
    }
  });

  it("parses --federation-token flag", () => {
    const r = parseNonInteractive(["--federation-token", "fed-secret"], HOME, DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.federationToken).toBe("fed-secret");
  });

  it("returns error string on invalid node", () => {
    const r = parseNonInteractive(["--node", "!@#"], HOME, DEFAULTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Node name");
  });
});
