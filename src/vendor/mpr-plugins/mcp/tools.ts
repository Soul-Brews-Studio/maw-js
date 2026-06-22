/**
 * tools.ts — pure argv mappers + the spawn-and-collect wrapper for `maw mcp`.
 *
 * Each `*Args` function is a PURE, unit-testable mapping from MCP tool input to
 * the argv array passed to the real `maw` CLI. `runMaw` spawns `maw <argv>`,
 * captures BOTH stdout and stderr (never inherit — that would corrupt the MCP
 * JSON-RPC channel on stdout), and returns a plain result. The spawn fn is
 * injectable so tests never touch real processes.
 */

// ── input shapes ────────────────────────────────────────────────────────────

export type InboxAction = "status" | "list" | "read";
export type CompanyAction = "ls" | "tree" | "attach";
export type DeptAction = "assign" | "members" | "learn" | "knowledge";

export interface CompanyInput {
  action: CompanyAction;
  company?: string;
  dept?: string;
}

export interface DeptInput {
  action: DeptAction;
  company?: string;
  dept?: string;
  oracle?: string;
  role?: string;
  text?: string;
}

// ── pure argv mappers ───────────────────────────────────────────────────────

export function heyArgs(target: string, message: string): string[] {
  return ["hey", target, message];
}

export function replyArgs(correlationId: string, message: string): string[] {
  return ["reply", correlationId, message];
}

export function inboxArgs(action: InboxAction, id?: string): string[] {
  switch (action) {
    case "status":
      // The inbox plugin treats bare `maw inbox` and `maw inbox status` the
      // same; we use the explicit `status` subcommand for clarity.
      return ["inbox", "status"];
    case "list":
      return ["inbox", "list"];
    case "read":
      if (!id) throw new Error("inbox read requires an id");
      return ["inbox", "read", id];
  }
}

export function lsArgs(verbose?: boolean): string[] {
  return verbose ? ["ls", "-v"] : ["ls"];
}

export function companyArgs(input: CompanyInput): string[] {
  switch (input.action) {
    case "ls":
      return ["company", "ls"];
    case "tree":
      return input.company ? ["company", "tree", input.company] : ["company", "tree"];
    case "attach":
      if (!input.company || !input.dept) {
        throw new Error("company attach requires company and dept");
      }
      return ["company", "attach", input.company, input.dept];
  }
}

export function deptArgs(input: DeptInput): string[] {
  const { action, company, dept, oracle, role, text } = input;
  switch (action) {
    case "assign": {
      if (!company || !dept || !oracle) {
        throw new Error("dept assign requires company, dept and oracle");
      }
      const argv = ["dept", "assign", company, dept, oracle];
      if (role) argv.push("--role", role);
      return argv;
    }
    case "members":
      if (!company || !dept) throw new Error("dept members requires company and dept");
      return ["dept", "members", company, dept];
    case "learn":
      if (!company || !dept || !text) {
        throw new Error("dept learn requires company, dept and text");
      }
      return ["dept", "learn", company, dept, text];
    case "knowledge": {
      if (!company || !dept) throw new Error("dept knowledge requires company and dept");
      const argv = ["dept", "knowledge", company, dept];
      if (text) argv.push(text);
      return argv;
    }
  }
}

// ── spawn-and-collect ───────────────────────────────────────────────────────

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Minimal subset of `Bun.spawn`'s subprocess we rely on, so the spawn fn can be
 * faked in tests without pulling in Bun types.
 */
export interface SpawnedProc {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
}

export type SpawnFn = (cmd: string[]) => SpawnedProc;

const defaultSpawn: SpawnFn = (cmd) =>
  // CRITICAL: pipe both streams. Inheriting stdout would let `maw`'s output
  // leak onto the MCP JSON-RPC channel and corrupt the protocol.
  Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as unknown as SpawnedProc;

async function readStream(s: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!s) return "";
  return await new Response(s).text();
}

/**
 * Spawn `maw <argv>`, capture both streams, await exit. Best-effort: any throw
 * (e.g. `maw` not on PATH) is mapped to a failed result — never propagated, so
 * the MCP server keeps running.
 */
export async function runMaw(argv: string[], spawn: SpawnFn = defaultSpawn): Promise<RunResult> {
  try {
    const proc = spawn(["maw", ...argv]);
    const [stdout, stderr, code] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, stdout: "", stderr: `failed to run maw: ${message}` };
  }
}

// ── MCP result mapping ──────────────────────────────────────────────────────

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // Index signature so this is structurally assignable to the SDK's
  // CallToolResult (which carries an open `[x: string]: unknown`).
  [x: string]: unknown;
}

/** Map a runMaw result to an MCP tool result. */
export function toMcpResult(r: RunResult): McpToolResult {
  if (r.ok) {
    return { content: [{ type: "text", text: r.stdout || "(ok)" }] };
  }
  return {
    content: [{ type: "text", text: r.stderr || r.stdout || "maw failed" }],
    isError: true,
  };
}
