import { Elysia, t } from "elysia";
import { tmux } from "../sdk";
import { loadConfig } from "../config";
import { buildAgentRows } from "../commands/shared/agents";

/**
 * GET /api/agents (and alias /api/agent)
 *
 * Returns the same data as `maw agents --json` — one row per pane, oracle
 * windows by default, all panes when `?all=1`.
 *
 * #1132 — surfaces the existing `cmdAgents` CLI through the HTTP API. The
 * pure `buildAgentRows` from commands/shared/agents.ts is reused here so the
 * CLI and API stay in lockstep.
 */
async function listAgents(query: { all?: string } | undefined) {
  const all = query?.all === "1" || query?.all === "true";
  const config = loadConfig();
  const nodeName = config.node || "local";

  const [sessions, panes] = await Promise.all([tmux.listAll(), tmux.listPanes()]);

  const windowNames = new Map<string, string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      windowNames.set(`${s.name}:${w.index}`, w.name);
    }
  }

  const rows = buildAgentRows(panes, windowNames, nodeName, { all });
  return { agents: rows, count: rows.length, node: nodeName };
}

const querySchema = t.Object({ all: t.Optional(t.String()) });

export const agentsApi = new Elysia()
  .get("/agents", ({ query }) => listAgents(query), { query: querySchema })
  .get("/agent", ({ query }) => listAgents(query), { query: querySchema });
