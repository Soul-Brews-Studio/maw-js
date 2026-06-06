/**
 * expand-probe.ts — optional live probe for `maw federation expand --probe`.
 * The planner stays pure; this module owns the opt-in network read.
 */

import { cfgTimeout } from "../../config";
import { curlFetch } from "../../sdk";
import type { ExpandProbeIdentity } from "./expand-plan";

export async function fetchExpandProbeIdentity(url: string, timeout?: number): Promise<ExpandProbeIdentity> {
  const identityUrl = `${url.replace(/\/+$/, "")}/api/identity`;
  try {
    const res = await curlFetch(identityUrl, { timeout: timeout ?? cfgTimeout("http"), from: "auto" });
    if (!res.ok || !res.data) {
      return {
        url: identityUrl,
        reachable: false,
        agents: [],
        status: res.status,
        error: `http ${res.status ?? "?"}`,
      };
    }
    const data = res.data as { node?: unknown; agents?: unknown };
    const agents = Array.isArray(data.agents) ? data.agents.filter((agent): agent is string => typeof agent === "string") : [];
    return {
      url: identityUrl,
      reachable: typeof data.node === "string",
      ...(typeof data.node === "string" ? { advertisedNode: data.node } : {}),
      agents,
      status: res.status,
      ...(typeof data.node === "string" ? {} : { error: "invalid identity shape" }),
    };
  } catch (e: any) {
    return {
      url: identityUrl,
      reachable: false,
      agents: [],
      status: 0,
      error: String(e?.message || e).split("\n")[0],
    };
  }
}
