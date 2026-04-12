/**
 * Tests for `maw ui` — pure helpers + the rendered output. The command is
 * print-only by design (no SSH spawn, no browser open, no process
 * management), so EVERYTHING is unit-testable: the helpers return strings,
 * renderUiOutput returns a string, the command just prints it.
 */

import { describe, test, expect } from "bun:test";
import {
  resolvePeerHostPort,
  justHost,
  buildLensUrl,
  buildTunnelCommand,
  parseUiArgs,
  renderUiOutput,
} from "../src/commands/ui";

// ---- resolvePeerHostPort -------------------------------------------------

describe("resolvePeerHostPort", () => {
  test("literal host:port → returns as-is", () => {
    expect(resolvePeerHostPort("10.20.0.16:3456")).toBe("10.20.0.16:3456");
    expect(resolvePeerHostPort("oracle-world:3456")).toBe("oracle-world:3456");
  });

  test("bare hostname → returns as-is", () => {
    expect(resolvePeerHostPort("oracle-world")).toBe("oracle-world");
  });

  test("hostnames with dots and dashes", () => {
    expect(resolvePeerHostPort("white.local:3456")).toBe("white.local:3456");
    expect(resolvePeerHostPort("my-oracle.example.com:3456")).toBe(
      "my-oracle.example.com:3456",
    );
  });

  test("empty / whitespace → null", () => {
    expect(resolvePeerHostPort("")).toBeNull();
    expect(resolvePeerHostPort("   ")).toBeNull();
  });

  test("garbage → null", () => {
    expect(resolvePeerHostPort("not a valid host!!!")).toBeNull();
    expect(resolvePeerHostPort("@#$%")).toBeNull();
  });
});

// ---- justHost ------------------------------------------------------------

describe("justHost", () => {
  test("strips port from host:port", () => {
    expect(justHost("oracle-world:3456")).toBe("oracle-world");
    expect(justHost("10.20.0.16:5173")).toBe("10.20.0.16");
  });

  test("returns hostname unchanged when no port", () => {
    expect(justHost("oracle-world")).toBe("oracle-world");
  });
});

// ---- buildLensUrl --------------------------------------------------------

describe("buildLensUrl", () => {
  test("default = 2D, no host param", () => {
    expect(buildLensUrl({})).toBe("http://localhost:5173/federation_2d.html");
  });

  test("--3d uses federation.html", () => {
    expect(buildLensUrl({ threeD: true })).toBe("http://localhost:5173/federation.html");
  });

  test("remoteHost adds URL-encoded ?host=", () => {
    expect(buildLensUrl({ remoteHost: "10.20.0.7:3456" })).toBe(
      "http://localhost:5173/federation_2d.html?host=10.20.0.7%3A3456",
    );
  });

  test("3d + remoteHost combine", () => {
    expect(buildLensUrl({ threeD: true, remoteHost: "10.20.0.7:3456" })).toBe(
      "http://localhost:5173/federation.html?host=10.20.0.7%3A3456",
    );
  });
});

// ---- buildTunnelCommand --------------------------------------------------

describe("buildTunnelCommand", () => {
  test("returns a single shell-paste-ready string", () => {
    const cmd = buildTunnelCommand({ user: "neo", host: "10.20.0.16" });
    expect(typeof cmd).toBe("string");
    expect(cmd.startsWith("ssh ")).toBe(true);
  });

  test("forwards both lens (5173) and maw-js (3456) ports", () => {
    const cmd = buildTunnelCommand({ user: "neo", host: "10.20.0.16" });
    expect(cmd).toContain("-L 5173:localhost:5173");
    expect(cmd).toContain("-L 3456:localhost:3456");
  });

  test("uses -N (no remote command) for foreground tunnel lifecycle", () => {
    // Transparent design: NO -f, NO -M, NO control socket. The user runs
    // this in a real terminal and Ctrl+C kills it.
    const cmd = buildTunnelCommand({ user: "neo", host: "10.20.0.16" });
    expect(cmd).toContain("-N");
    expect(cmd).not.toContain("-f");
    expect(cmd).not.toContain("-M");
    expect(cmd).not.toContain("-S");
    expect(cmd).not.toContain("ControlMaster");
  });

  test("user@host is the final positional", () => {
    const cmd = buildTunnelCommand({ user: "neo", host: "10.20.0.16" });
    expect(cmd.endsWith("neo@10.20.0.16")).toBe(true);
  });
});

// ---- parseUiArgs ---------------------------------------------------------

describe("parseUiArgs", () => {
  test("empty args → empty options", () => {
    expect(parseUiArgs([])).toEqual({});
  });

  test("bare positional → peer", () => {
    expect(parseUiArgs(["white"])).toEqual({ peer: "white" });
  });

  test("--tunnel + peer", () => {
    expect(parseUiArgs(["--tunnel", "oracle-world"])).toEqual({
      tunnel: true,
      peer: "oracle-world",
    });
  });

  test("flag order doesn't matter", () => {
    expect(parseUiArgs(["oracle-world", "--tunnel"])).toEqual({
      tunnel: true,
      peer: "oracle-world",
    });
  });

  test("--3d", () => {
    expect(parseUiArgs(["--3d"])).toEqual({ threeD: true });
  });

  test("--3d combines with peer", () => {
    expect(parseUiArgs(["white", "--3d"])).toEqual({ peer: "white", threeD: true });
  });

  test("unknown flags silently ignored (forward-compatible)", () => {
    expect(parseUiArgs(["white", "--unknown"])).toEqual({ peer: "white" });
  });

  test("first positional wins", () => {
    expect(parseUiArgs(["white", "oracle-world"])).toEqual({ peer: "white" });
  });
});

// ---- renderUiOutput — the load-bearing surface --------------------------

describe("renderUiOutput — bare mode", () => {
  test("no args → just the local URL on one line", () => {
    const out = renderUiOutput({});
    // Port depends on Shape A: 3456 if ~/.maw/ui/dist installed, 5173 otherwise
    expect(out).toMatch(/^http:\/\/localhost:\d+\/federation_2d\.html$/);
    // No comments, no extra noise — pipe-friendly.
    expect(out).not.toContain("#");
    expect(out.split("\n").length).toBe(1);
  });

  test("--3d → federation.html", () => {
    const out = renderUiOutput({ threeD: true });
    expect(out).toMatch(/^http:\/\/localhost:\d+\/federation\.html$/);
  });
});

describe("renderUiOutput — peer mode", () => {
  test("literal peer → URL with encoded ?host=", () => {
    const out = renderUiOutput({ peer: "10.20.0.7:3456" });
    expect(out).toMatch(/^http:\/\/localhost:\d+\/federation_2d\.html\?host=10\.20\.0\.7%3A3456$/);
    expect(out.split("\n").length).toBe(1);
  });

  test("unknown peer → comment-prefixed error (still parseable)", () => {
    const out = renderUiOutput({ peer: "garbage!!!" });
    expect(out).toContain("# unknown peer: garbage!!!");
    // Comments only — no URL line, no SSH command. Caller eyeballs it.
  });
});

describe("renderUiOutput — tunnel mode", () => {
  test("--tunnel + literal peer → SSH command + URL block", () => {
    const out = renderUiOutput({ tunnel: true, peer: "10.20.0.16" });

    // Shell-safe comments explain each section
    expect(out).toContain("# Run this on your local machine");
    expect(out).toContain("# Then open in your browser:");
    expect(out).toContain("# Stop the tunnel with Ctrl+C");

    // The actual SSH command line is unwrapped and copy-pasteable
    expect(out).toContain("ssh -N");
    expect(out).toContain("-L 5173:localhost:5173");
    expect(out).toContain("-L 3456:localhost:3456");
    expect(out).toContain("@10.20.0.16");

    // The URL is on its own line for easy copy (port depends on Shape A install state)
    expect(out).toMatch(/http:\/\/localhost:\d+\/federation_2d\.html/);
  });

  test("--tunnel without peer → usage hint", () => {
    const out = renderUiOutput({ tunnel: true });
    expect(out).toContain("# usage: maw ui --tunnel <peer>");
    // No SSH command, no URL — nothing to copy
    expect(out).not.toContain("ssh ");
  });

  test("--tunnel + unknown peer → comment-prefixed error", () => {
    const out = renderUiOutput({ tunnel: true, peer: "garbage!!!" });
    expect(out).toContain("# unknown peer: garbage!!!");
    expect(out).not.toContain("ssh ");
  });

  test("--tunnel + --3d → 3d URL after the SSH command", () => {
    const out = renderUiOutput({ tunnel: true, peer: "10.20.0.16", threeD: true });
    expect(out).toContain("federation.html");
    expect(out).not.toContain("federation_2d.html");
  });
});

// ---- Pipe-friendliness invariant (load-bearing) -------------------------

describe("the pipe-friendliness invariant", () => {
  // The whole point of "transparent / print-only" is that the URL or SSH
  // command is on its own line, no ANSI escapes, no decorative output
  // wrapping the load-bearing text. You can grep / tail / pipe / xargs.

  test("bare mode is one line, no ANSI, no comments", () => {
    const out = renderUiOutput({});
    expect(out).not.toMatch(/\x1b\[/); // no ANSI
    expect(out).not.toContain("#"); // no comments
    expect(out.split("\n").length).toBe(1);
  });

  test("peer mode is one line, no ANSI, no comments (when peer resolves)", () => {
    const out = renderUiOutput({ peer: "10.20.0.7:3456" });
    expect(out).not.toMatch(/\x1b\[/);
    expect(out).not.toContain("#");
    expect(out.split("\n").length).toBe(1);
  });

  test("tunnel mode keeps SSH and URL on their OWN lines (no inline labels)", () => {
    const out = renderUiOutput({ tunnel: true, peer: "10.20.0.16" });
    const lines = out.split("\n");

    // The SSH command is its own line with NO leading text
    const sshLine = lines.find((l) => l.startsWith("ssh "));
    expect(sshLine).not.toBeUndefined();
    expect(sshLine).toContain("-L 3456:localhost:3456");
    expect(sshLine).toContain("@10.20.0.16");

    // The URL is its own line with NO leading text
    const urlLine = lines.find((l) => l.startsWith("http://"));
    expect(urlLine).not.toBeUndefined();
    expect(urlLine).toMatch(/^http:\/\/localhost:\d+\/federation_2d\.html$/);
  });

  test("no ANSI escapes anywhere in tunnel mode output", () => {
    const out = renderUiOutput({ tunnel: true, peer: "10.20.0.16" });
    expect(out).not.toMatch(/\x1b\[/);
  });
});

// ---- Dual-port forwarding invariant (load-bearing) ----------------------

describe("the dual-port forwarding invariant", () => {
  test("buildTunnelCommand ALWAYS forwards both lens AND maw-js ports", () => {
    // The whole point of `maw ui --tunnel` is that the user can hit BOTH
    // localhost:5173 (lens) AND localhost:3456 (maw-js API) on their
    // local machine. If this invariant breaks, the lens still works but
    // `maw <cmd>` calls from the local machine no longer reach the
    // remote backend.
    const cmd = buildTunnelCommand({ user: "neo", host: "10.20.0.16" });
    const lForwards = cmd.match(/-L \d+:localhost:\d+/g) ?? [];
    expect(lForwards.length).toBe(2);
    expect(lForwards).toContain("-L 5173:localhost:5173");
    expect(lForwards).toContain("-L 3456:localhost:3456");
  });
});
