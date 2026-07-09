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
  | "add" | "ls" | "start" | "move" | "claim" | "assign" | "ask" | "mentions" | "comment" | "comments" | "review" | "hold" | "approve" | "need-answer" | "pr" | "done" | "note" | "edit" | "epic" | "dep" | "decompose" | "block" | "unblock" | "archive";

/** One child in a decompose plan (kobo-146 C7). Mirror of the store's DecomposeChild — kept local so tools.ts stays a pure argv mapper with no core import. */
export interface DecomposePlanChild {
  title: string;
  body?: string;
  deps?: string[]; // existing card id | "$N" sibling ref (0-indexed into children[])
  assignee?: string;
  reviewer?: string;
}

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
  repo?: string;       // add / pr (owner/name — pr stamps card.repo)
  dept?: string;       // add
  epic?: string;       // add
  state?: string;      // add (backlog|todo) / move (target flow state)
  assignee?: string;   // add
  parent?: string[];   // add (repeatable deps)
  body?: string;       // add
  op?: string;         // dep (required: add|rm)
  mine?: boolean;      // ls
  for?: string;        // ls (decision queue) / block (--for)
  to?: string;         // review / assign (target ball-holder)
  force?: boolean;     // assign: --force-reassign (reassign is friction, correction only — kobo-219)
  gate?: boolean;      // hold: --gate — route the brake to the approve lane (Tony's queue), not review (kobo-224)
  reviewer?: string;   // add (persistent per-card reviewer, kobo-144)
  reason?: string;     // review / hold / block
  kind?: string;       // block (required)
  days?: number;       // archive
  text?: string;       // note/comment (required) — note or comment content
  replyTo?: string;    // comment: thread under this comment id
  tldr?: string;       // comment: 1-line outcome/decision — REQUIRED on a @tony/@human comment (kobo-263)
  ask?: string;        // comment: what Tony must do — REQUIRED on a @tony/@human comment (kobo-263)
  detail?: string;     // comment: optional evidence/context (rendered collapsed)
  children?: DecomposePlanChild[]; // decompose (required): the plan's child cards
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
      if (input.state) argv.push("--state", input.state);
      if (input.reason) argv.push("--reason", input.reason); // kobo-218: add --state approve → deploy-approval card carries WHY (CLI enforces reason)
      if (input.assignee) argv.push("--assignee", input.assignee);
      if (input.reviewer) argv.push("--reviewer", input.reviewer);
      for (const p of input.parent ?? []) argv.push("--parent", p);
      if (input.body) argv.push("--body", input.body);
      return [...argv, ...common()];
    }
    case "move": {
      const mid = needId("move");
      if (!input.state) throw new Error("task move requires a state (backlog|todo|ready|approve|need-answer)");
      const argv = ["company", "task", "move", mid, input.state];
      // kobo-191/218: moving into approve OR need-answer carries a mandatory reason
      // (both are Tony's queues — forward it so the CLI doesn't reject the MCP move).
      if (input.state === "approve" || input.state === "need-answer") {
        if (!input.reason) throw new Error(`task move to ${input.state} requires a reason (${input.state === "approve" ? "why this card needs a human decision" : "what you need Tony to answer"})`);
        argv.push("--reason", input.reason);
      }
      return [...argv, ...common()];
    }
    case "approve": {
      // kobo-191: reviewer routes big-work review → approve (human gate). reason
      // mandatory — the Approve lane must say why each card is in Tony's queue.
      const aid = needId("approve");
      if (!input.reason) throw new Error("task approve requires a reason (money/hash/live/deploy/schema/cross-co/unsure — why it needs Tony)");
      return ["company", "task", "approve", aid, "--reason", input.reason, ...common()];
    }
    case "need-answer": {
      // kobo-235: mirror `approve` — the Need-answer lane is Tony's DECISION queue.
      // reason mandatory (what decision/direction the card waits on).
      const nid = needId("need-answer");
      if (!input.reason) throw new Error("task need-answer requires a reason (what decision/direction you need Tony to answer)");
      return ["company", "task", "need-answer", nid, "--reason", input.reason, ...common()];
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
    case "assign": {
      const aid = needId("assign");
      if (!input.to) throw new Error("task assign requires --to <who>");
      const argv = ["company", "task", "assign", aid, "--to", input.to];
      if (input.force) argv.push("--force-reassign"); // reassign is friction (kobo-219)
      return [...argv, ...common()];
    }
    case "ask": {
      // Substantive question → subcard (kobo-126). id=parent card, text=question,
      // to=answerer (default tony, handled by the CLI verb).
      const askParent = needId("ask");
      if (!input.text) throw new Error("task ask requires text (the question)");
      const argv = ["company", "task", "ask", askParent, input.text];
      if (input.to) argv.push("--to", input.to);
      return [...argv, ...common()];
    }
    case "mentions": {
      // Unanswered @mention decision queue (kobo-126). Optional --for <who>.
      const argv = ["company", "task", "mentions", ...common()];
      if (input.for) argv.push("--for", input.for);
      return argv;
    }
    case "done":
      return ["company", "task", "done", needId("done"), ...common()];
    case "unblock":
      return ["company", "task", "unblock", needId("unblock"), ...common()];
    case "note": {
      const nid = needId("note");
      if (!input.text) throw new Error("task note requires text");
      return ["company", "task", "note", nid, input.text, ...common()];
    }
    case "edit": {
      // kobo-213/214 — reword a card's title/body/reviewer in place (same id,
      // lineage intact). At least one field must be given; nothing else is touched.
      const eid = needId("edit");
      if (input.title === undefined && input.body === undefined && input.reviewer === undefined) {
        throw new Error("task edit requires title, body, and/or reviewer");
      }
      const argv = ["company", "task", "edit", eid];
      if (input.title !== undefined) argv.push("--title", input.title);
      if (input.body !== undefined) argv.push("--body", input.body);
      if (input.reviewer !== undefined) argv.push("--reviewer", input.reviewer);
      return [...argv, ...common()];
    }
    case "comment": {
      // kobo-140 — threaded ask/answer comment. id=card, text=body, optional
      // replyTo threads under an existing comment id.
      const cid = needId("comment");
      if (!input.text) throw new Error("task comment requires text");
      const argv = ["company", "task", "comment", cid, input.text];
      if (input.replyTo) argv.push("--reply-to", input.replyTo);
      // kobo-263 — structured clarity for a @tony/@human comment (tldr + ask required,
      // detail optional). Passed through to the CLI gate (parity: same reject on the wire).
      if (input.tldr) argv.push("--tldr", input.tldr);
      if (input.ask) argv.push("--ask", input.ask);
      if (input.detail) argv.push("--detail", input.detail);
      return [...argv, ...common()];
    }
    case "comments":
      return ["company", "task", "comments", needId("comments"), ...common()];
    // kobo-237: the `resolve` action is removed — the resolve concept is gone.
    case "epic": {
      // kobo-72 — set/clear containment parent. epic set → re-link; omit → --clear.
      const eid = needId("epic");
      if (input.epic) return ["company", "task", "epic", eid, input.epic, ...common()];
      return ["company", "task", "epic", eid, "--clear", ...common()];
    }
    case "dep": {
      // kobo-134 — dep add/rm <id> <parentId>. The single parent id rides the
      // existing `parent` field (same field the add verb uses for dep ids);
      // exactly one is required so nothing is silently dropped.
      const did = needId("dep");
      if (input.op !== "add" && input.op !== "rm") throw new Error("task dep requires op (add|rm)");
      if (!input.parent || input.parent.length !== 1) {
        throw new Error("task dep requires exactly one parent id (parent: [<cardId>])");
      }
      return ["company", "task", "dep", input.op, did, input.parent[0], ...common()];
    }
    case "decompose": {
      // kobo-146 C7 — materialize a decomposition plan. The plan (children[]) rides
      // --plan as a JSON string (runMaw is argv-only, no stdin). id = the epic card.
      const decId = needId("decompose");
      if (!input.children || !input.children.length) throw new Error("task decompose requires a non-empty children[] plan");
      return ["company", "task", "decompose", decId, "--plan", JSON.stringify(input.children), ...common()];
    }
    case "review": {
      const argv = ["company", "task", "review", needId("review")];
      if (input.to) argv.push("--to", input.to);
      if (input.reason) argv.push("--reason", input.reason);
      return [...argv, ...common()];
    }
    case "hold": {
      // kobo-144: reviewer's brake — pull card into review from any state.
      // kobo-224: gate=true → route to the approve lane (Tony's queue) instead of
      // review, replacing hold+@tony (reason required with gate).
      const argv = ["company", "task", "hold", needId("hold")];
      if (input.reason) argv.push("--reason", input.reason);
      if (input.gate) argv.push("--gate");
      return [...argv, ...common()];
    }
    case "pr": {
      // kobo-147: forward --repo. MCP has no CWD git remote to fall back on, so
      // without this the CLI stamps card.repo from the maw subprocess CWD (the
      // wrong repo — the bug both Phase-C workers hit). An explicit repo names
      // the repo the PR actually lives in so pr-watch can poll it.
      const pid = needId("pr");
      if (input.pr === undefined) throw new Error("task pr requires a pr number");
      const argv = ["company", "task", "pr", pid, String(input.pr)];
      if (input.repo) argv.push("--repo", input.repo);
      return [...argv, ...common()];
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
