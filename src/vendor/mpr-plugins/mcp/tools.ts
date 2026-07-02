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
export type TaskAction =
  | "add" | "ls" | "start" | "claim" | "review" | "pr" | "done" | "block" | "unblock" | "archive";

export interface CompanyInput {
  action: CompanyAction;
  company?: string;
  dept?: string;
}

/**
 * All params the task board CLI accepts, across every verb (see the task plugin
 * `maw task <verb>`). Optional; `taskArgs` validates the per-action requirements
 * and only emits flags that are set — a 1:1 mapping to the CLI, no new logic.
 */
export interface TaskInput {
  action: TaskAction;
  id?: string;
  title?: string;      // add
  pr?: number;         // pr
  company?: string;
  from?: string;
  repo?: string;       // add
  dept?: string;       // add
  epic?: string;       // add
  assignee?: string;   // add
  parent?: string[];   // add (repeatable deps)
  body?: string;       // add
  mine?: boolean;      // ls
  for?: string;        // ls (decision queue) / block (--for)
  to?: string;         // review
  reason?: string;     // review / block
  kind?: string;       // block (required)
  days?: number;       // archive
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

/**
 * Map a task-board tool call to `maw company task <verb> …` argv — 1:1 with the
 * CLI, no new behavior. `--company`/`--from` apply to every verb; the rest are
 * per-action. `--from` is optional: when the `maw mcp` subprocess spawns
 * `maw company task`, CLAUDE_AGENT_NAME is inherited so the actor already
 * resolves; `from` only overrides it (tests / explicit sender).
 *
 * Targets the canonical `maw company task` (cli-reorg kobo-24) — NOT the
 * `maw task` deprecation shim, so no "moved" notice leaks into MCP output.
 */
export function taskArgs(input: TaskInput): string[] {
  const { action, id, company, from } = input;
  // Common flags every verb accepts, appended after the verb's positionals.
  const common = (): string[] => {
    const f: string[] = [];
    if (company) f.push("--company", company);
    if (from) f.push("--from", from);
    return f;
  };
  const needId = (verb: string): string => {
    if (!id) throw new Error(`task ${verb} requires an id`);
    return id;
  };

  switch (action) {
    case "add": {
      if (!input.title) throw new Error("task add requires a title");
      const argv = ["company", "task", "add", input.title];
      if (input.repo) argv.push("--repo", input.repo);
      if (input.dept) argv.push("--dept", input.dept);
      if (input.epic) argv.push("--epic", input.epic);
      if (input.assignee) argv.push("--assignee", input.assignee);
      for (const p of input.parent ?? []) argv.push("--parent", p);
      if (input.body) argv.push("--body", input.body);
      return [...argv, ...common()];
    }
    case "ls": {
      const argv = ["company", "task", "ls", ...common()];
      if (input.mine) argv.push("--mine");
      if (input.for) argv.push("--for", input.for);
      return argv;
    }
    case "start":
      return ["company", "task", "start", needId("start"), ...common()];
    case "claim":
      return ["company", "task", "claim", needId("claim"), ...common()];
    case "done":
      return ["company", "task", "done", needId("done"), ...common()];
    case "unblock":
      return ["company", "task", "unblock", needId("unblock"), ...common()];
    case "review": {
      const argv = ["company", "task", "review", needId("review")];
      if (input.to) argv.push("--to", input.to);
      if (input.reason) argv.push("--reason", input.reason);
      return [...argv, ...common()];
    }
    case "pr": {
      const pid = needId("pr");
      if (input.pr === undefined) throw new Error("task pr requires a pr number");
      return ["company", "task", "pr", pid, String(input.pr), ...common()];
    }
    case "block": {
      const bid = needId("block");
      if (!input.kind) throw new Error("task block requires a kind");
      const argv = ["company", "task", "block", bid, "--kind", input.kind];
      if (input.reason) argv.push("--reason", input.reason);
      if (input.for) argv.push("--for", input.for);
      return [...argv, ...common()];
    }
    case "archive": {
      // Per-card archive by id (kobo-35) takes precedence over the bulk --days
      // sweep — an id is a positional, the two forms never mix in one call.
      if (id) return ["company", "task", "archive", id, ...common()];
      const argv = ["company", "task", "archive", ...common()];
      if (input.days !== undefined) argv.push("--days", String(input.days));
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
