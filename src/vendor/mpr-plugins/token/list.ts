/**
 * maw token list — port of token-oracle/cmd/list.py.
 *
 * Shows the current dir's active token plus all vault tokens and saved
 * .envrcs. Active token marked with "← active". Never prints token
 * values — only names.
 */

import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import { PASS_PREFIX, detectActiveToken, listEnvrcNames, listTokenNames } from "./lib";

export interface ListResult {
  ok: true;
  cwd: string;
  active: string | null;
  envrcPresent: boolean;
  tokens: string[];
  envrcs: string[];
}

export function cmdList(cwd: string = process.cwd()): ListResult {
  const envrcPath = `${cwd}/.envrc`;
  const envrcPresent = existsSync(envrcPath);

  let active: string | null = null;
  if (envrcPresent) {
    try {
      active = detectActiveToken(readFileSync(envrcPath, "utf-8"));
    } catch {
      active = null;
    }
  }

  return {
    ok: true,
    cwd,
    active,
    envrcPresent,
    tokens: listTokenNames(),
    envrcs: listEnvrcNames(),
  };
}

export function formatList(r: ListResult): string {
  const out: string[] = [];
  const dir = basename(r.cwd) || "/";
  if (r.active) {
    out.push(`Here (${dir}): ${r.active}`);
  } else if (r.envrcPresent) {
    out.push(`Here (${dir}): .envrc present, no CLAUDE_TOKEN_NAME`);
  } else {
    out.push(`Here (${dir}): no .envrc`);
  }
  out.push("");

  if (r.tokens.length > 0) {
    out.push("Tokens (claude/):");
    r.tokens.forEach((name, i) => {
      const marker = name === r.active ? " ← active" : "";
      out.push(`  ${i + 1}. ${name}${marker}`);
    });
    out.push("");
  }

  if (r.envrcs.length > 0) {
    out.push(`Envrcs (${PASS_PREFIX}/):`);
    r.envrcs.forEach((name, i) => {
      out.push(`  ${i + 1}. ${name}`);
    });
    out.push("");
  }

  if (r.tokens.length === 0 && r.envrcs.length === 0) {
    out.push("Empty vault. Add tokens: pass insert claude/token-<name>");
  }

  return out.join("\n");
}
