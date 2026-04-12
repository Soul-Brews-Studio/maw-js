/**
 * Pulse API — GitHub Issues proxy for Dashboard Pro kanban panel.
 *
 * Wraps gh CLI so the browser doesn't need a GitHub token.
 * Reads from the Pulse repo (laris-co/pulse-oracle by default).
 *
 * GET  /api/pulse           → list open issues (kanban items)
 * POST /api/pulse           → create issue
 * PATCH /api/pulse/:id      → update issue (labels, assignee, state)
 */

import { Hono } from "hono";
import { hostExec } from "../ssh";
import { loadConfig } from "../config";

export const pulseApi = new Hono();

function getPulseRepo(): string {
  return (loadConfig() as any).pulseRepo || "Soul-Brews-Studio/maw-js";
}

pulseApi.get("/pulse", async (c) => {
  const repo = c.req.query("repo") || getPulseRepo();
  const state = c.req.query("state") || "open";
  const limit = c.req.query("limit") || "50";
  try {
    const raw = await hostExec(
      `gh issue list --repo ${repo} --state ${state} --limit ${limit} --json number,title,state,labels,assignees,createdAt,updatedAt`
    );
    const issues = JSON.parse(raw || "[]");
    return c.json({ repo, issues });
  } catch (e: any) {
    return c.json({ error: e.message, repo }, 500);
  }
});

pulseApi.post("/pulse", async (c) => {
  const { title, body, labels, oracle } = await c.req.json();
  if (!title) return c.json({ error: "title required" }, 400);
  const repo = getPulseRepo();
  const labelFlags = labels?.length ? `-l "${labels.join(",")}"` : "";
  const oracleLabel = oracle ? `-l "oracle:${oracle}"` : "";
  try {
    const url = await hostExec(
      `gh issue create --repo ${repo} -t '${title.replace(/'/g, "'\\''")}' -b '${(body || "").replace(/'/g, "'\\''")}' ${labelFlags} ${oracleLabel}`
    );
    return c.json({ ok: true, url: url.trim() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

pulseApi.patch("/pulse/:id", async (c) => {
  const id = c.req.param("id");
  const { addLabels, removeLabels, state } = await c.req.json();
  const repo = getPulseRepo();
  const cmds: string[] = [];
  if (addLabels?.length) cmds.push(`gh issue edit ${id} --repo ${repo} --add-label "${addLabels.join(",")}"`);
  if (removeLabels?.length) cmds.push(`gh issue edit ${id} --repo ${repo} --remove-label "${removeLabels.join(",")}"`);
  if (state === "closed") cmds.push(`gh issue close ${id} --repo ${repo}`);
  if (state === "open") cmds.push(`gh issue reopen ${id} --repo ${repo}`);
  if (!cmds.length) return c.json({ error: "nothing to update" }, 400);
  try {
    for (const cmd of cmds) await hostExec(cmd);
    return c.json({ ok: true, id });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
