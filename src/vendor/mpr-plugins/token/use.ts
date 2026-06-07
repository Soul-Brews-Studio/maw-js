/**
 * maw token use — port of token-oracle/cmd/use.py.
 *
 * Atomic .envrc rewrite: strip old token lines, append new export
 * block, then `direnv allow .` so the change takes effect. The token
 * value never lives in this process — `.envrc` references it via a
 * `pass show` subshell, which direnv evaluates at activation time.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { TOKEN_PREFIX, passExists, run } from "./lib";

export interface UseResult {
  ok: boolean;
  name?: string;
  content?: string;
  error?: string;
  direnvOk?: boolean;
}

export interface UseOptions {
  name: string;
  noTeam?: boolean;
  cwd?: string;
  /** Skip `direnv allow .` — used by tests. */
  skipDirenv?: boolean;
}

/**
 * Build the rewritten .envrc content given the existing content (may
 * be empty) and the desired token name. Pure function — exposed for
 * testing without filesystem.
 */
export function buildEnvrcContent(existing: string, name: string, noTeam: boolean): string {
  const tokenLines = [
    `export CLAUDE_TOKEN_NAME="${name}"`,
    `export CLAUDE_CODE_OAUTH_TOKEN="$(pass show ${TOKEN_PREFIX}${name})"`,
  ];
  if (!noTeam) {
    tokenLines.push("export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
  }

  if (!existing) {
    return tokenLines.join("\n") + "\n";
  }

  const lines = existing.split("\n");
  // Preserve trailing newline awareness: split("\n") on "a\n" yields
  // ["a", ""] — we'll re-join below and trim trailing empties.
  const kept: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith("export CLAUDE_TOKEN_NAME=")) continue;
    if (s.startsWith("export CLAUDE_CODE_OAUTH_TOKEN=")) continue;
    if (s.startsWith("CLAUDE_CODE_OAUTH_TOKEN=")) continue;
    if (s.startsWith("CLAUDE_TOKEN_NAME=")) continue;
    if (s.startsWith("export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=")) continue;
    // Legacy var-ref formats: TOKEN_PYM, TOKEN_DO, TOKEN_TING_TING
    if (/^(export\s+)?TOKEN_(PYM|DO|TING_TING)=/.test(s)) continue;
    kept.push(line);
  }

  // Trim trailing blank lines from the kept block.
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }

  let content = kept.join("\n");
  if (content && !content.endsWith("\n")) content += "\n";
  content += "\n" + tokenLines.join("\n") + "\n";
  return content;
}

export function cmdUse(opts: UseOptions): UseResult {
  const { name, noTeam = false } = opts;
  const cwd = opts.cwd ?? process.cwd();

  if (!name) {
    return { ok: false, error: "usage: maw token use <name> [--no-team]" };
  }

  const passPath = `${TOKEN_PREFIX}${name}`;
  if (!passExists(passPath)) {
    return { ok: false, error: `token "${name}" not found in pass (${passPath})` };
  }

  const envrcPath = `${cwd}/.envrc`;
  const existing = existsSync(envrcPath) ? readFileSync(envrcPath, "utf-8") : "";
  const content = buildEnvrcContent(existing, name, noTeam);

  writeFileSync(envrcPath, content);

  let direnvOk = true;
  if (!opts.skipDirenv) {
    const r = run(["direnv", "allow", "."], { cwd });
    direnvOk = r.ok;
  }

  return { ok: true, name, content, direnvOk };
}
