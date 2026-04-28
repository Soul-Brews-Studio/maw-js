/**
 * Tests for src/commands/plugins/init/prompts.ts — pure validators.
 */
import { describe, it, expect } from "bun:test";
import {
  validateNodeName,
  validateGhqRoot,
  validatePeerUrl,
  validatePeerName,
} from "../../src/commands/plugins/init/prompts";

describe("validateNodeName", () => {
  it("accepts lowercase alphanumeric", () => {
    expect(validateNodeName("mba")).toBeNull();
  });

  it("accepts uppercase", () => {
    expect(validateNodeName("MBA")).toBeNull();
  });

  it("accepts hyphens", () => {
    expect(validateNodeName("my-node")).toBeNull();
  });

  it("accepts digits", () => {
    expect(validateNodeName("node1")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateNodeName("")).not.toBeNull();
  });

  it("rejects leading hyphen", () => {
    expect(validateNodeName("-node")).not.toBeNull();
  });

  it("rejects underscores", () => {
    expect(validateNodeName("my_node")).not.toBeNull();
  });

  it("rejects spaces", () => {
    expect(validateNodeName("my node")).not.toBeNull();
  });

  it("rejects dots", () => {
    expect(validateNodeName("my.node")).not.toBeNull();
  });

  it("accepts max length (63 chars)", () => {
    expect(validateNodeName("a" + "b".repeat(62))).toBeNull();
  });

  it("rejects over 63 chars", () => {
    expect(validateNodeName("a" + "b".repeat(63))).not.toBeNull();
  });

  it("accepts single char", () => {
    expect(validateNodeName("a")).toBeNull();
  });

  it("rejects special characters", () => {
    expect(validateNodeName("node@1")).not.toBeNull();
    expect(validateNodeName("node!")).not.toBeNull();
  });
});

describe("validateGhqRoot", () => {
  const home = "/Users/testuser";

  it("accepts absolute path", () => {
    const r = validateGhqRoot("/home/user/repos", home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("/home/user/repos");
  });

  it("expands tilde to homedir", () => {
    const r = validateGhqRoot("~/repos", home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("/Users/testuser/repos");
  });

  it("rejects empty string", () => {
    const r = validateGhqRoot("", home);
    expect(r.ok).toBe(false);
  });

  it("rejects relative path", () => {
    const r = validateGhqRoot("repos/here", home);
    expect(r.ok).toBe(false);
  });

  it("accepts root path", () => {
    const r = validateGhqRoot("/", home);
    expect(r.ok).toBe(true);
  });

  it("tilde-only resolves to homedir", () => {
    const r = validateGhqRoot("~", home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("/Users/testuser");
  });
});

describe("validatePeerUrl", () => {
  it("accepts http URL", () => {
    expect(validatePeerUrl("http://localhost:3456")).toBeNull();
  });

  it("accepts https URL", () => {
    expect(validatePeerUrl("https://peer.example.com")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validatePeerUrl("")).not.toBeNull();
  });

  it("rejects URL without protocol", () => {
    expect(validatePeerUrl("localhost:3456")).not.toBeNull();
  });

  it("rejects ftp URL", () => {
    expect(validatePeerUrl("ftp://example.com")).not.toBeNull();
  });

  it("rejects invalid URL", () => {
    expect(validatePeerUrl("http://")).not.toBeNull();
  });

  it("accepts URL with port", () => {
    expect(validatePeerUrl("http://192.168.1.1:3456")).toBeNull();
  });

  it("accepts URL with path", () => {
    expect(validatePeerUrl("https://peer.example.com/api")).toBeNull();
  });
});

describe("validatePeerName", () => {
  it("accepts simple name", () => {
    expect(validatePeerName("kc")).toBeNull();
  });

  it("accepts hyphenated name", () => {
    expect(validatePeerName("my-peer")).toBeNull();
  });

  it("accepts digits", () => {
    expect(validatePeerName("peer1")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validatePeerName("")).not.toBeNull();
  });

  it("rejects leading hyphen", () => {
    expect(validatePeerName("-peer")).not.toBeNull();
  });

  it("rejects over 31 chars", () => {
    expect(validatePeerName("a" + "b".repeat(31))).not.toBeNull();
  });

  it("accepts max length (31 chars)", () => {
    expect(validatePeerName("a" + "b".repeat(30))).toBeNull();
  });

  it("rejects underscores", () => {
    expect(validatePeerName("my_peer")).not.toBeNull();
  });

  it("rejects spaces", () => {
    expect(validatePeerName("my peer")).not.toBeNull();
  });
});
