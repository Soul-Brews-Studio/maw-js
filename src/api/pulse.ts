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
import { hostExec } from "../core/transport/ssh";
import { loadConfig, type MawConfig } from "../config";

const LABEL_RE = /^[a-zA-Z0-9_:/.\- ]+$/;
function assertLabels(labels: string[]): void {
  for (const l of labels) {
    if (!LABEL_RE.test(l)) throw new Error(`Invalid label: ${JSON.stringify(l)}`);
  }
}

async function ghSpawn(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `gh exited ${code}`);
  return out;
}

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
  try {
    const allLabels = [...(labels || [])];
    if (oracle) allLabels.push(`oracle:${oracle}`);
    assertLabels(allLabels);
    const args = ["issue", "create", "--repo", repo, "-t", title, "-b", issueBody || ""];
    for (const l of allLabels) args.push("-l", l);
    const url = await ghSpawn(args);
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
  try {
    const ops: Array<() => Promise<string>> = [];
    if (addLabels?.length) {
      assertLabels(addLabels);
      ops.push(() => ghSpawn(["issue", "edit", id, "--repo", repo, "--add-label", addLabels.join(",")]));
    }
    if (removeLabels?.length) {
      assertLabels(removeLabels);
      ops.push(() => ghSpawn(["issue", "edit", id, "--repo", repo, "--remove-label", removeLabels.join(",")]));
    }
    if (state === "closed") ops.push(() => ghSpawn(["issue", "close", id, "--repo", repo]));
    if (state === "open") ops.push(() => ghSpawn(["issue", "reopen", id, "--repo", repo]));
    if (!ops.length) { set.status = 400; return { error: "nothing to update" }; }
    for (const op of ops) await op();
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
