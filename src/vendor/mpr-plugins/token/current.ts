/**
 * maw token current — port of token-oracle/cmd/current.py.
 *
 * Prints the active token name for statusline integration. Silent on
 * missing .envrc or no recognised format. Never prints token values.
 */

import { existsSync, readFileSync } from "fs";
import { detectActiveToken } from "./lib";

export function cmdCurrent(cwd: string = process.cwd()): string | null {
  const path = `${cwd}/.envrc`;
  if (!existsSync(path)) return null;
  try {
    return detectActiveToken(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
