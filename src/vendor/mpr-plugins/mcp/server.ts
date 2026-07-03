/**
 * server.ts — builds the stdio MCP server that wraps the real `maw` CLI.
 *
 * Each tool spawns `maw <verb> ...` (see tools.ts) and relays its output.
 * Identity / Rule-6 signing happen INSIDE `maw` — this layer only relays.
 *
 * CRITICAL: stdout is the MCP JSON-RPC channel. All logging goes to stderr
 * (console.error). Tool subprocesses pipe their own stdout (never inherit).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  heyArgs,
  replyArgs,
  inboxArgs,
  lsArgs,
  companyArgs,
  deptArgs,
  taskArgs,
  runMaw,
  toMcpResult,
  type SpawnFn,
} from "./tools";
import { inlineImages, defaultInlineImagesDeps } from "./inline-images";

export interface BuildOptions {
  /** Injectable spawn (default Bun.spawn via runMaw). Mostly for tests. */
  spawn?: SpawnFn;
}

export function buildServer(opts: BuildOptions = {}): McpServer {
  const { spawn } = opts;
  const server = new McpServer({ name: "maw", version: "0.1.0" });
  // Wrap each handler so a thrown mapper error becomes a clean MCP error
  // result instead of crashing the server.
  const guard = async (build: () => string[]): Promise<CallToolResult> => {
    let argv: string[];
    try {
      argv = build();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text }], isError: true };
    }
    return toMcpResult(await runMaw(argv, spawn));
  };

  server.registerTool(
    "maw_hey",
    {
      title: "Send a message to another oracle",
      description:
        "Send a message to a target oracle/peer (maw hey <target> <message>). " +
        "Sender is auto-signed as a [node:oracle] envelope (derived from CLAUDE_AGENT_NAME / the tmux session).",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Target address. Formats: `<oracle>` (bare local name); `<session>:<window>`; " +
              "`<session>:<window>.<pane>` — the `.N` suffix routes to a SPECIFIC pane (needed when a " +
              "window has multiple panes, e.g. a coordinator in pane 1 beside a PM in pane 0; without it, " +
              "delivery auto-picks the lowest-index agent pane, NOT necessarily the one you replied from); " +
              "`<node>:<oracle>` for a cross-node peer (the explicit `<node>:` prefix is required to leave the local node).",
          ),
        message: z.string().describe("message body"),
      },
    },
    async ({ target, message }) => guard(() => heyArgs(target, message)),
  );

  server.registerTool(
    "maw_reply",
    {
      title: "Reply to a request",
      description: "Reply to a [request:<correlationId>] (maw reply <correlationId> <message>).",
      inputSchema: {
        correlationId: z.string().describe("correlationId from the [request:<id>] prompt"),
        message: z.string().describe("reply body"),
      },
    },
    async ({ correlationId, message }) => guard(() => replyArgs(correlationId, message)),
  );

  server.registerTool(
    "maw_inbox",
    {
      title: "Inbox status / list / read",
      description:
        "Check the inbox: status (maw inbox status), list (maw inbox list), or read an item (maw inbox read <id>).",
      inputSchema: {
        action: z.enum(["status", "list", "read"]).describe("inbox action"),
        id: z.string().optional().describe("message id (required for action=read)"),
      },
    },
    async ({ action, id }) => guard(() => inboxArgs(action, id)),
  );

  server.registerTool(
    "maw_ls",
    {
      title: "List oracles / sessions",
      description: "List oracles (maw ls). Pass verbose for the detailed view (maw ls -v).",
      inputSchema: {
        verbose: z.boolean().optional().describe("verbose listing (maw ls -v)"),
      },
    },
    async ({ verbose }) => guard(() => lsArgs(verbose)),
  );

  server.registerTool(
    "maw_company",
    {
      title: "Company ls / tree / attach",
      description:
        "Company ops: ls (maw company ls), tree (maw company tree [company]), attach (maw company attach <company> <dept>).",
      inputSchema: {
        action: z.enum(["ls", "tree", "attach"]).describe("company action"),
        company: z.string().optional().describe("company name (tree optional, attach required)"),
        dept: z.string().optional().describe("dept name (required for attach)"),
      },
    },
    async ({ action, company, dept }) => guard(() => companyArgs({ action, company, dept })),
  );

  server.registerTool(
    "maw_dept",
    {
      title: "Dept assign / members / learn / knowledge",
      description:
        "Dept ops: assign (maw dept assign <company> <dept> <oracle> [--role <role>]), members, learn (maw dept learn <company> <dept> \"<text>\"), knowledge (maw dept knowledge <company> <dept> [text]).",
      inputSchema: {
        action: z.enum(["assign", "members", "learn", "knowledge"]).describe("dept action"),
        company: z.string().optional().describe("company name"),
        dept: z.string().optional().describe("dept name"),
        oracle: z.string().optional().describe("oracle name (required for assign)"),
        role: z.string().optional().describe("role (optional for assign)"),
        text: z.string().optional().describe("text to learn (required for learn; query for knowledge)"),
      },
    },
    async ({ action, company, dept, oracle, role, text }) =>
      guard(() => deptArgs({ action, company, dept, oracle, role, text })),
  );

  server.registerTool(
    "maw_task",
    {
      title: "Company task board — add/ls/start/move/claim/review/pr/done/note/block/unblock/archive",
      description:
        "Company task board ops (maw task <verb>). action=add (title required · [--state backlog|todo]) · ls ([--mine] [--for who]) · start/claim/done/unblock (<id>) · move (<id> + state backlog|todo — re-file parking states) · review (<id> [--to oracle] [--reason]) · pr (<id> + pr number) · note (<id> + text = append-only note, mid-flight truth) · block (<id> --kind <dependency|needs_input|capability|transient> [--reason] [--for]) · archive (<id> = archive ONE reviewed done card off the board; OR [--days N] = bulk-sweep done cards older than N days). --company/--from apply to any verb.",
      inputSchema: {
        action: z
          .enum(["add", "ls", "start", "move", "claim", "review", "pr", "done", "note", "block", "unblock", "archive"])
          .describe("task board action"),
        id: z.string().optional().describe("card id (start/claim/done/review/pr/block/unblock; archive = per-card by id)"),
        title: z.string().optional().describe("card title (required for add)"),
        pr: z.number().optional().describe("PR number (required for pr)"),
        company: z.string().optional().describe("company (else resolved from config)"),
        from: z.string().optional().describe("acting oracle override (else inherited from env)"),
        repo: z.string().optional().describe("add: repo"),
        dept: z.string().optional().describe("add: department"),
        epic: z.string().optional().describe("add: epic"),
        state: z.enum(["backlog", "todo"]).optional().describe("add: start state (default todo) · move: target parking state"),
        assignee: z.string().optional().describe("add: assignee oracle"),
        parent: z.array(z.string()).optional().describe("add: parent/dep card ids"),
        body: z.string().optional().describe("add: markdown body (supports checklist)"),
        mine: z.boolean().optional().describe("ls: only my cards"),
        for: z.string().optional().describe("ls: decision queue for who · block: --for"),
        to: z.string().optional().describe("review: reviewer oracle"),
        reason: z.string().optional().describe("review/block: reason text"),
        text: z.string().optional().describe("note: append-only note text (required for note)"),
        kind: z
          .enum(["dependency", "needs_input", "capability", "transient"])
          .optional()
          .describe("block: block kind (required for block)"),
        days: z.number().optional().describe("archive: sweep done older than N days"),
      },
    },
    async (input) => guard(() => taskArgs(input)),
  );

  // Unlike the other tools, this one resolves IN-PROCESS (no `maw` subprocess):
  // it owns the `maw://` concept and only needs config + fetch. Fail-fast errors
  // map to an isError result so the caller never receives markdown that still
  // has an unresolved `maw://` in it.
  server.registerTool(
    "maw_inline_images",
    {
      title: "Inline maw:// image refs as base64",
      description:
        "Scan markdown for maw://<node>/<file> image refs, fetch each from the mesh, and replace them with data:image/...;base64 URIs — returning markdown with NO maw:// left. Fail-fast: if any ref can't be resolved (unknown node, 404, too large, unsupported type) the whole call fails and names the ref. Knows nothing about any downstream consumer; it only returns markdown.",
      inputSchema: {
        markdown: z.string().describe("markdown that may contain maw://<node>/<uuid>.<ext> image refs"),
      },
    },
    async ({ markdown }): Promise<CallToolResult> => {
      try {
        const out = await inlineImages(markdown, defaultInlineImagesDeps());
        return { content: [{ type: "text", text: out }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
  );

  return server;
}
