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
import {
  roomRead,
  roomReply,
  roomMerge,
  roomClose,
  roomOpen,
  defaultRoomClientDeps,
  type RoomClientDeps,
} from "./room-client";

export interface BuildOptions {
  /** Injectable spawn (default Bun.spawn via runMaw). Mostly for tests. */
  spawn?: SpawnFn;
  /** Injectable room HTTP client deps (default live fetch). */
  roomDeps?: RoomClientDeps;
}

export function buildServer(opts: BuildOptions = {}): McpServer {
  const { spawn } = opts;
  const rd = opts.roomDeps ?? defaultRoomClientDeps();
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
      title: "Company task board — add/ls/start/move/claim/assign/ask/mentions/comment/comments/review/hold/pr/done/note/edit/epic/dep/decompose/block/unblock/archive",
      description:
        "Company task board ops (maw task <verb>). action=add (title required · [--state backlog|todo|approve] — state approve CREATES a deploy/critical card straight into the Approve lane, --reason then REQUIRED, kobo-218) · ls ([--mine] [--for who]) · start/claim/done/unblock (<id>) · assign (<id> --to who = hand the ball to the current holder without taking it; assignee=human when the next move is Tony's — the pass-ball gesture for no-PR decision/gate cards) · ask (<id>=parent + text=question [--to who] = a substantive question becomes its own subcard assigned to the answerer, default tony, linked under the parent — one shot) · mentions ([--for who] = list @tony/@human comment-mentions across the board, the decision queue; read-only) · comment (<id> + text [--replyTo cid] = threaded ask/answer comment; @mentions ping the mentioned + poke assignee — the ask channel, distinct from note) · comments (<id> = list a card's comment thread) · move (<id> + state backlog|todo|ready|approve|need-answer — re-file lanes; ready normally auto-promotes when parent deps are all done, manual move = override; move to approve/need-answer = Tony's queues, requires reason — need-answer = a decision/direction question, approve = a yes/no deploy/big gate) · review (<id> [--to oracle] [--reason]) · hold (<id> [--reason] = reviewer's brake — pull a card into review from any state so it can't proceed until looked at; notifies the resolved reviewer: reviewer field → creator → human) · approve (<id> + reason REQUIRED = reviewer routes big-work review → approve, the human gate before done — money/hash/live/deploy/schema/cross-co/unsure per rule 12; small work the reviewer just closes done; no auto-transition) · need-answer (<id> + reason REQUIRED = park a card in Tony's DECISION queue — a decision/direction question, mirrors approve; kobo-235) · pr (<id> + pr number) · sign (<id> + role crew|head = record a merge-gate sign, kobo-327) · merge (<id> [--method] [--single-tier] = the gated merge — REFUSES until required signs present, then gh pr merge; the only merge path. kobo-331 FAIL-CLOSED: an unset crewGate refuses rather than merging head-only — declare the tier: crew-cell → `sign --role crew`, genuine single-tier → --single-tier) · deployed (<id> = manual deploy-drain: flip a wait-for-deploy card → done once the merged feature is live; refused on any other state, never dones a non-waiting card — deploy stays manual, kobo-275) · note (<id> + text = append-only note, mid-flight truth/evidence, no questions) · edit (<id> + title, body, and/or reviewer = amend a card in place, same id — lineage/deps/thread/PR/state/assignee untouched; the old value is preserved in an append-only audit note; does NOT touch hash/idempotency) · epic (<id> + epic = set containment parent, re-links a same-id dep; omit epic = clear it) · dep (<id> + op add|rm + parent [<cardId>] = link/unlink a dependency after create — <id> waits for the parent; self/containment-conflict/cycle rejected, idempotent) · decompose (<id>=epic + children[] = materialize a CONFIRMED decomposition plan into child cards under the epic + dep links; each child {title, body?, deps?, assignee?, reviewer?}, deps entries link a sibling '$N' (0-indexed into children) or a literal card id. The LLM drafts the plan; this verb only executes it — idempotent (a child whose title already exists is skipped), reports what landed on partial failure) · block (<id> --kind <dependency|needs_input|capability|transient> [--reason] [--for]) · archive (<id> = archive ONE reviewed done card off the board; OR [--days N] = bulk-sweep done cards older than N days). --company/--from apply to any verb.",
      inputSchema: {
        action: z
          .enum(["add", "ls", "start", "move", "claim", "assign", "ask", "mentions", "comment", "comments", "review", "hold", "approve", "need-answer", "pr", "sign", "merge", "done", "deployed", "note", "edit", "epic", "dep", "decompose", "block", "unblock", "archive"])
          .describe("task board action"),
        id: z.string().optional().describe("card id (start/claim/assign/done/review/pr/block/unblock; archive = per-card by id; ask = parent card id; comment/comments = the card)"),
        title: z.string().optional().describe("card title (required for add · edit: new title, reword in place)"),
        pr: z.number().optional().describe("PR number (required for pr)"),
        company: z.string().optional().describe("company (else resolved from config)"),
        from: z.string().optional().describe("acting oracle override (else inherited from env)"),
        repo: z.string().optional().describe("add / pr: repo (owner/name — pr stamps card.repo for pr-watch)"),
        dept: z.string().optional().describe("add: department"),
        epic: z.string().optional().describe("add: epic · epic action: containment parent id (omit = clear)"),
        state: z.enum(["backlog", "todo", "ready", "approve", "need-answer", "wait-for-deploy"]).optional().describe("add: start state (backlog|todo default, or approve = create a deploy-approval card, --reason REQUIRED) · move: target lane (backlog|todo|ready parking; approve/need-answer = Tony's queues, reason REQUIRED; wait-for-deploy = merged-not-live park, kobo-273)"),
        assignee: z.string().optional().describe("add: assignee oracle"),
        parent: z.array(z.string()).optional().describe("add: parent/dep card ids · dep: the ONE parent id to link/unlink"),
        op: z.enum(["add", "rm"]).optional().describe("dep: link (add) or unlink (rm) — required for dep"),
        body: z.string().optional().describe("add: markdown body (supports checklist) · edit: new body, reword in place"),
        mine: z.boolean().optional().describe("ls: only my cards"),
        for: z.string().optional().describe("ls: decision queue for who · block: --for · mentions: filter to one person's queue"),
        to: z.string().optional().describe("review: reviewer oracle · assign: new assignee · ask: answerer (default tony)"),
        force: z.boolean().optional().describe("assign: --force-reassign — required to displace an existing owner (reassign is friction, correction only; handoff = subtask, kobo-219)"),
        gate: z.boolean().optional().describe("hold: --gate — the reviewer judges this a Tony-gate (big) card → route the brake to the approve lane (Tony's queue) instead of review, replacing hold+@tony; reason required. Pure lane move, never auto-deploys (kobo-224)"),
        reviewer: z.string().optional().describe("add: persistent per-card reviewer (resolve chain head → creator → human, kobo-144)"),
        role: z.enum(["crew", "head"]).optional().describe("sign (REQUIRED, kobo-327): which merge-gate tier signs — crew = crew-cell pre-PR gate, head = final gate before merge"),
        crewGate: z.boolean().optional().describe("add (kobo-327): mark a crew-cell card → `merge` needs a crew pre-sign in addition to head (the anti-race funnel)"),
        method: z.enum(["merge", "squash", "rebase"]).optional().describe("merge (kobo-327): gh merge method, default merge"),
        singleTier: z.boolean().optional().describe("merge (kobo-331): declare a genuine no-crew card → head-only merge. The explicit escape when crewGate is unset (fail-closed refuses otherwise); rejected if the card is crew-gated."),
        deployRequired: z.boolean().optional().describe("add/edit (kobo-274): override the merge-park default. true → this card's PR merge parks in wait-for-deploy (merged≠live); false → straight to done. Unset → defaults to has-a-PR."),
        reason: z.string().optional().describe("review/hold/block: reason text · approve/move-to-approve/move-to-need-answer/add-state-approve: REQUIRED (why it's in Tony's queue)"),
        text: z.string().optional().describe("note: append-only note text (required for note) · ask: the question (required for ask) · comment: the comment body (required for comment)"),
        replyTo: z.string().optional().describe("comment: thread under this comment id (optional)"),
        children: z
          .array(z.object({
            title: z.string().describe("child card title (outcome — detail goes in body)"),
            body: z.string().optional().describe("markdown body — AC (Given/When/Then), detail, unhappy paths"),
            deps: z.array(z.string()).optional().describe("dep refs: '$N' = the Nth child in this plan (0-indexed), or a literal existing card id"),
            assignee: z.string().optional().describe("assignee oracle"),
            reviewer: z.string().optional().describe("persistent per-card reviewer (kobo-144)"),
          }))
          .optional()
          .describe("decompose: the plan's child cards (required for decompose)"),
        kind: z
          .enum(["dependency", "needs_input", "capability", "transient"])
          .optional()
          .describe("block: block kind (required for block)"),
        days: z.number().optional().describe("archive: sweep done older than N days"),
      },
    },
    async (input) => guard(() => taskArgs(input)),
  );

  // ── room tools — thin HTTP wrappers (no subprocess) ──────────────────────────

  server.registerTool(
    "maw_room_read",
    {
      title: "Read a brainstorm room thread",
      description:
        "GET /api/room/thread — returns the persisted room artifact (messages[], topic, status). " +
        "Default-capped to the last 20 turns so a large room never blows the token cap. " +
        "Use `last`/`since` to page, or `all` for the full thread.",
      inputSchema: {
        company: z.string().describe("company the room belongs to"),
        room: z.string().describe("room id"),
        last: z.number().int().nonnegative().optional().describe("return only the last N turns (0 = all); default 20 when unset"),
        since: z.union([z.number(), z.string()]).optional().describe("return only turns at/after this time (epoch ms or ISO date)"),
        all: z.boolean().optional().describe("return the full thread (overrides the default 20-turn cap)"),
      },
    },
    async ({ company, room, last, since, all }): Promise<CallToolResult> => {
      const r = await roomRead({ company, room, last, since, all }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    "maw_room_reply",
    {
      title: "Reply into a brainstorm room",
      description:
        "POST /api/room/reply — write an oracle reply directly into the room artifact. " +
        "`from` must be a verified oracle of the room (Rule-6 enforced server-side).",
      inputSchema: {
        company: z.string().describe("company the room belongs to"),
        room: z.string().describe("room id"),
        from: z.string().describe("the oracle replying (bare name, e.g. eq3)"),
        text: z.string().describe("reply text"),
      },
    },
    async ({ company, room, from, text }): Promise<CallToolResult> => {
      const r = await roomReply({ company, room, from, text }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    "maw_room_merge",
    {
      title: "Merge rooms into a target",
      description:
        "POST /api/room/merge — consolidate one or more source rooms INTO a target room. " +
        "Sources are archived (never deleted). Calling this tool IS the confirmation (confirm:true is forwarded automatically).",
      inputSchema: {
        company: z.string().describe("company the rooms belong to"),
        target: z.string().describe("target room id (absorbs sources)"),
        sources: z.array(z.string()).min(1).describe("source room ids to merge into target"),
      },
    },
    async ({ company, target, sources }): Promise<CallToolResult> => {
      const r = await roomMerge({ company, target, sources }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    "maw_room_close",
    {
      title: "Close a brainstorm room",
      description:
        "POST /api/room/close — mark a room closed (thread preserved, reopenable). " +
        "Use when a room's topic is resolved.",
      inputSchema: {
        company: z.string().describe("company the room belongs to"),
        room: z.string().describe("room id to close"),
      },
    },
    async ({ company, room }): Promise<CallToolResult> => {
      const r = await roomClose({ company, room }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    "maw_room_open",
    {
      title: "Open (create or reopen) a brainstorm room",
      description:
        "POST /api/room/open — create a new room or reopen a closed one (idempotent; keeps existing thread). " +
        "The room is always scoped to a company.",
      inputSchema: {
        company: z.string().describe("company to open the room under"),
        room: z.string().describe("room id"),
        topic: z.string().optional().describe("short topic/title for the room"),
      },
    },
    async ({ company, room, topic }): Promise<CallToolResult> => {
      const r = await roomOpen({ company, room, topic }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
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
