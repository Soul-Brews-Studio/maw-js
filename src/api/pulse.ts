/**
 * Pulse API -- GitHub Issues proxy for Dashboard Pro kanban panel.
 *
 * Wraps gh CLI so the browser doesn't need a GitHub token.
 * Reads from the Pulse repo (laris-co/pulse-oracle by default).
 *
 * GET  /api/pulse           -> list open issues (kanban items)
 * POST /api/pulse           -> create issue
 * PATCH /api/pulse/:id      -> update issue (labels, assignee, state)
 */

import { Elysia, t} from "elysia";
import { hostExec } from "../ssh";
import { loadConfig, type MawConfig } from "../config";

export const pulseApi = new Elysia();

function getPulseRepo(): string {
  const config = loadConfig() as MawConfig & { pulseRepo?: string };
  return config.pulseRepo || "Soul-Brews-Studio/maw-js";
}

pulseApi.get("/pulse", async ({ query, set}) => {
  const repo = query.repo || getPulseRepo();
  const state = query.state || "open";
  const limit = query.limit || "50";
  try {
    const raw = await hostExec(
      `gh issue list --repo ${repo} --state ${state} --limit ${limit} --json number,title,state,labels,assignees,createdAt,updatedAt`
    );
    const issues = JSON.parse(raw || "[]");
    return { repo, issues };
  } catch (e: any) {
    set.status = 500; return { error: e.message, repo };
  }
}, {
  query: t.Object({
    repo: t.Optional(t.String()),
    state: t.Optional(t.String()),
    limit: t.Optional(t.String()),
  }),
});

pulseApi.post("/pulse", async ({ body, set}) => {
  const { title, body: issueBody, labels, oracle } = body;
  if (!title) { set.status = 400; return { error: "title required" }; }
  const repo = getPulseRepo();
  const labelFlags = labels?.length ? `-l "${labels.join(",")}"` : "";
  const oracleLabel = oracle ? `-l "oracle:${oracle}"` : "";
  try {
    const url = await hostExec(
      `gh issue create --repo ${repo} -t '${title.replace(/'/g, "'\\''")}' -b '${(issueBody || "").replace(/'/g, "'\\''")}' ${labelFlags} ${oracleLabel}`
    );
    return { ok: true, url: url.trim() };
  } catch (e: any) {
    set.status = 500; return { error: e.message };
  }
}, {
  body: t.Object({
    title: t.Optional(t.String()),
    body: t.Optional(t.String()),
    labels: t.Optional(t.Array(t.String())),
    oracle: t.Optional(t.String()),
  }),
});

pulseApi.patch("/pulse/:id", async ({ params, body, set}) => {
  const id = params.id;
  const { addLabels, removeLabels, state } = body;
  const repo = getPulseRepo();
  const cmds: string[] = [];
  if (addLabels?.length) cmds.push(`gh issue edit ${id} --repo ${repo} --add-label "${addLabels.join(",")}"`);
  if (removeLabels?.length) cmds.push(`gh issue edit ${id} --repo ${repo} --remove-label "${removeLabels.join(",")}"`);
  if (state === "closed") cmds.push(`gh issue close ${id} --repo ${repo}`);
  if (state === "open") cmds.push(`gh issue reopen ${id} --repo ${repo}`);
  if (!cmds.length) { set.status = 400; return { error: "nothing to update" }; }
  try {
    for (const cmd of cmds) await hostExec(cmd);
    return { ok: true, id };
  } catch (e: any) {
    set.status = 500; return { error: e.message };
  }
}, {
  params: t.Object({ id: t.String() }),
  body: t.Object({
    addLabels: t.Optional(t.Array(t.String())),
    removeLabels: t.Optional(t.Array(t.String())),
    state: t.Optional(t.String()),
  }),
});
