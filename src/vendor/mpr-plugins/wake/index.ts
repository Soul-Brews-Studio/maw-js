import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "wake",
  description: "Spawn or attach to an oracle session",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  // Dynamic imports — clean, one await, mockable
  const { cmdWake } = await import("maw-js/commands/shared/wake");
  const { cmdWakeAll } = await import("maw-js/commands/shared/fleet");
  const { parseWakeTarget, ensureCloned } = await import("maw-js/commands/shared/wake-target");
  const { fetchGitHubPrompt } = await import("maw-js/commands/shared/wake-resolve");

  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    if (ctx.source === "cli") {
      const args = ctx.args as string[];

      if (!args[0]) {
        return {
          ok: false,
          error: "usage: maw wake <oracle|org/repo|URL> [task] [--task \"<prompt>\"] [--wt <name>] [--fresh] [--attach] [--issue N] [--pr N] [--repo org/name] [--list] [--all-local] [--peer <alias>]\n       maw wake all [--kill]\n       --list previews worktrees only; no tmux session/window changes\n       (--new is a deprecated alias for --wt, removed in alpha.114)",
        };
      }

      if (args[0].toLowerCase() === "all") {
        const flags = parseFlags(args, { "--kill": Boolean, "--all": Boolean, "--resume": Boolean }, 1);
        await cmdWakeAll({ kill: flags["--kill"], all: flags["--all"], resume: flags["--resume"] });
        return { ok: true, output: logs.join("\n") || undefined };
      }

      if (args.includes("--new")) {
        console.error("\x1b[33m⚠\x1b[0m --new renamed to --wt (removed in alpha.114)");
      }

      const flags = parseFlags(args, {
        "--wt": String, "--new": "--wt",
        "--incubate": String, "--issue": Number,
        "--pr": Number, "--repo": String, "--task": String,
        "--fresh": Boolean, "--attach": Boolean, "-a": "--attach",
        "--no-attach": Boolean, // #823 Bug B — register so it doesn't fall through to positional → wakeOpts.task
        "--list": Boolean, "--ls": "--list",
        "--split": Boolean,
        "--all-local": Boolean,
        "--peer": String,
      }, 1);

      if (flags["--peer"]) {
        return await forwardToPeer(flags["--peer"], args[0], flags);
      }

      const wakeOpts: {
        task?: string; wt?: string; prompt?: string;
        incubate?: string; fresh?: boolean; attach?: boolean; listWt?: boolean;
        split?: boolean; urlRepoName?: string; allLocal?: boolean;
      } = {};
      let issueNum: number | null = flags["--issue"] ?? null;
      let repo: string | undefined = flags["--repo"];

      const parsed = parseWakeTarget(args[0]);
      const oracleName = parsed ? parsed.oracle : args[0];
      if (parsed) {
        await ensureCloned(parsed.slug);
        if (parsed.issueNum) { issueNum = parsed.issueNum; repo = parsed.slug; }
        // #769 — pass the FULL repo name through so detectSession resolves on
        // the explicit URL intent rather than the stripped sub-token.
        wakeOpts.urlRepoName = parsed.slug.split("/").pop();
      }

      if (flags["--wt"]) wakeOpts.wt = flags["--wt"];
      if (flags["--incubate"]) wakeOpts.incubate = flags["--incubate"];
      if (flags["--fresh"]) wakeOpts.fresh = true;
      if (flags["--attach"]) wakeOpts.attach = true;
      if (flags["--no-attach"]) wakeOpts.attach = false; // #823 Bug B — explicit opt-out; preserves default when neither flag is set
      if (flags["--list"]) wakeOpts.listWt = true;
      if (flags["--split"]) wakeOpts.split = true;
      if (flags["--all-local"]) wakeOpts.allLocal = true;

      const positionals = flags._;
      if (positionals.length > 0) wakeOpts.task = positionals[0];
      if (positionals.length > 1) wakeOpts.prompt = positionals.slice(1).join(" ");

      if (wakeOpts.incubate && !repo) { repo = wakeOpts.incubate; }
      const prNum: number | null = flags["--pr"] ?? null;
      if (issueNum) {
        console.log(`\x1b[36m⚡\x1b[0m fetching issue #${issueNum}...`);
        wakeOpts.prompt = await fetchGitHubPrompt("issue", issueNum, repo);
        if (!wakeOpts.task) wakeOpts.task = `issue-${issueNum}`;
      } else if (prNum) {
        console.log(`\x1b[36m⚡\x1b[0m fetching PR #${prNum}...`);
        wakeOpts.prompt = await fetchGitHubPrompt("pr", prNum, repo);
        if (!wakeOpts.task) wakeOpts.task = `pr-${prNum}`;
      } else if (flags["--task"]) {
        wakeOpts.prompt = flags["--task"];
      }

      await cmdWake(oracleName, wakeOpts);
      return { ok: true, output: logs.join("\n") || undefined };
    }

    // API source
    const body = ctx.args as Record<string, unknown>;
    const oracle = body.oracle as string | undefined;
    if (!oracle) return { ok: false, error: "missing oracle name" };

    const wakeOpts: {
      task?: string; prompt?: string; wt?: string;
      fresh?: boolean; attach?: boolean;
    } = {};
    if (body.task) wakeOpts.task = body.task as string;
    if (body.wt) wakeOpts.wt = body.wt as string;
    if (body.prompt) wakeOpts.prompt = body.prompt as string;
    if (body.issue) {
      const issueNum = body.issue as number;
      wakeOpts.prompt = await fetchGitHubPrompt("issue", issueNum, body.repo as string | undefined);
      if (!wakeOpts.task) wakeOpts.task = `issue-${issueNum}`;
    } else if (body.pr) {
      const prNum = body.pr as number;
      wakeOpts.prompt = await fetchGitHubPrompt("pr", prNum, body.repo as string | undefined);
      if (!wakeOpts.task) wakeOpts.task = `pr-${prNum}`;
    }
    if (body.fresh) wakeOpts.fresh = true;
    if (body.attach) wakeOpts.attach = true;

    await cmdWake(oracle, wakeOpts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

/**
 * Forward a `maw wake` CLI invocation to a federation peer's /api/wake
 * endpoint instead of spawning a local tmux session. Enables cross-node
 * agent dispatch (e.g. brain → headless GPU node) without bespoke wrappers.
 *
 * Alias lookup goes through `~/.maw/peers.json` (the same store managed by
 * `maw peers`). Unknown alias surfaces as an `ok: false` plugin error
 * rather than throwing, so the CLI layer prints a clean message. Network
 * + non-2xx responses are mapped the same way.
 *
 * The forwarded body is a subset of CLI flags translated into the API
 * handler's vocabulary (above): `oracle`, optional worktree `task`/`wt`,
 * `prompt`, `issue`/`pr`/`repo`, `fresh`. Attach is intentionally not
 * forwarded — there is no local tmux to attach to on the remote node.
 */
async function forwardToPeer(
  alias: string,
  oracle: string,
  flags: Record<string, any>,
): Promise<InvokeResult> {
  const { resolvePeer } = await import("./internal/peer-resolve");
  const peer = resolvePeer(alias);
  if (!peer) return { ok: false, error: `unknown peer alias: ${alias} (see: maw peers list)` };

  const positionals: string[] = Array.isArray(flags._) ? flags._ : [];
  const body: Record<string, unknown> = { oracle };
  if (positionals.length > 0) body.task = positionals[0];
  if (flags["--wt"]) body.wt = flags["--wt"];
  if (flags["--task"]) body.prompt = flags["--task"];
  if (flags["--issue"]) body.issue = flags["--issue"];
  if (flags["--pr"]) body.pr = flags["--pr"];
  if (flags["--repo"]) body.repo = flags["--repo"];
  if (flags["--fresh"]) body.fresh = true;

  const { callPeerWake } = await import("./internal/peer-call");
  let res: { ok: boolean; status?: number; data?: any };
  try {
    res = await callPeerWake(peer.url, body);
  } catch (e: any) {
    return { ok: false, error: `peer wake failed (${alias} ${peer.url}): ${e?.message || e}` };
  }

  if (!res?.ok) {
    if (res?.status === 404) {
      return { ok: false, error: `peer ${alias} does not support /api/wake (HTTP 404 at ${peer.url})` };
    }
    const detail = res?.data?.error || (res?.status ? `HTTP ${res.status}` : "no response");
    return { ok: false, error: `peer wake failed (${alias} ${peer.url}): ${detail}` };
  }

  const summary = `\x1b[32m⚡\x1b[0m forwarded wake → ${alias} (${peer.url}) — ${oracle}`;
  const remoteOut = typeof res.data?.output === "string" ? res.data.output : "";
  return { ok: true, output: remoteOut ? `${summary}\n${remoteOut}` : summary };
}
