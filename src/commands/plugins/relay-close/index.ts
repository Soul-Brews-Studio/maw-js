import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import {
  parseRelayCloseArgs,
  runRelayClose,
  validateRelayArtifacts,
} from "./impl";
import {
  createStateRecorder,
  relayRuntimePaths,
  scheduleRelayClose,
} from "./runtime";

export const command = {
  name: "relay-close",
  description: "Fast MAW close transaction from a verified retrospective + handoff; no helper agent or worktree.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  try {
    if (ctx.source !== "cli") {
      return { ok: false, error: "relay-close is CLI-only" };
    }
    let opts = parseRelayCloseArgs(ctx.args as string[]);
    opts = validateRelayArtifacts(opts);

    if (opts.dryRun) {
      const output = [
        "relay-close dry-run: artifacts valid",
        `target: ${opts.target}`,
        `retrospective: ${opts.retrospectivePath}`,
        `handoff: ${opts.handoffPath}`,
        `recap: /recap ${opts.handoffPath}`,
      ].join("\n");
      return { ok: true, output };
    }

    if (opts.foreground || opts.internalRun) {
      const paths = relayRuntimePaths(opts.jobId ?? `foreground-${process.pid}`);
      const state = await runRelayClose(opts, {
        recordState: createStateRecorder(paths.statePath),
      });
      const output = `relay-close ${state.status}: ${state.handoffPath}`;
      return { ok: true, output };
    }

    const scheduled = await scheduleRelayClose(opts);
    const output = [
      `relay-close scheduled: ${scheduled.jobId} (PID ${scheduled.pid})`,
      `state: ${scheduled.paths.statePath}`,
      `log: ${scheduled.paths.logPath}`,
      "stop this turn now; the detached worker will wait for the pane to become idle",
    ].join("\n");
    return { ok: true, output };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
