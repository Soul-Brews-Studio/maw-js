/**
 * Significance filter (filter "b") — raw CC feed event → worklog entry, or null.
 *
 * Captures:
 *   - PostToolUse      state-changing tool calls (git/gh Bash, Edit/Write); drops read-only
 *   - UserPromptSubmit decisions/instructions ("Tony→oracle: X")  → kind "conversation"
 *
 * PR / claim events are written directly by their modules, so they return null here.
 * The company is resolved from the oracle so the entry routes to the right log.
 */

import type { FeedEvent } from "../../lib/feed";
import type { WorklogEntry } from "./types";
import { companyOfOracle } from "./company-scope";

const READONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "WebFetch", "WebSearch",
]);

const MAX_SUMMARY = 160;

function clip(s: string, max = MAX_SUMMARY): string {
  s = s.trim().replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** One-line summary for a significant tool, or null if not significant. */
export function toolSummary(toolName: string, input: any): string | null {
  if (toolName === "Bash") {
    const cmd = String(input?.command ?? "").trim();
    if (!cmd) return null;
    if (!/\b(git|gh)\b/.test(cmd)) return null; // only git/gh shell is fleet-significant
    return clip(cmd);
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    const fp = String(input?.file_path ?? input?.filePath ?? "").trim();
    return clip(`${toolName} ${fp}`);
  }
  return null;
}

/** Convert a capture feed event into a worklog entry, or null to skip. */
export function eventToWorklog(event: FeedEvent): WorklogEntry | null {
  const base = {
    ts: event.ts || Date.now(),
    iso: event.timestamp || new Date().toISOString(),
    oracle: event.oracle || "unknown",
    company: companyOfOracle(event.oracle) ?? undefined,
  };
  const data: any = event.data;

  // interrupt — emitted by worklog-convo.sh when the CC transcript shows the
  // prior turn ended with "[Request interrupted by user...]". (pr-* Notification
  // kinds are written directly by the poller, so they are NOT handled here.)
  if (data?.kind === "interrupt") {
    const correction = String(data.prompt ?? "").trim();
    return {
      ...base,
      kind: "interrupt",
      summary: clip(correction ? `interrupted → ${correction}` : "interrupted by user"),
    };
  }

  if (event.event === "PostToolUse" || event.event === "PreToolUse") {
    const toolName = String(data?.tool_name ?? data?.toolName ?? "");
    if (!toolName || READONLY_TOOLS.has(toolName)) return null;
    const summary = toolSummary(toolName, data?.tool_input ?? data?.toolInput);
    if (!summary) return null;
    return { ...base, kind: "tool", summary };
  }

  if (event.event === "UserPromptSubmit") {
    const prompt = String(data?.prompt ?? event.message ?? "").trim();
    if (!prompt) return null;
    return { ...base, kind: "conversation", summary: clip(prompt) };
  }

  return null;
}
