import { createInterface } from "readline";
import { createReadStream, openSync } from "fs";

export type AskFn = (question: string, defaultVal?: string) => Promise<string>;

export async function ttyAsk(question: string, defaultVal = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    let fd: number;
    try {
      fd = openSync("/dev/tty", "r+");
    } catch (e) {
      reject(new Error("/dev/tty unavailable — use --non-interactive"));
      return;
    }
    const rl = createInterface({
      input: createReadStream("/dev/tty", { fd }),
      output: process.stdout,
      terminal: true,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const PEER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/i;

export function validateNodeName(name: string): string | null {
  if (!NODE_NAME_RE.test(name)) {
    return "Node name must be 1-63 chars, letters/digits/hyphens only";
  }
  return null;
}

/**
 * @deprecated (#680) — `ghqRoot` is no longer asked at init. Retained only so
 * third-party callers that imported this validator keep compiling. The init
 * flow resolves ghq root on demand via `getGhqRoot()`.
 */
export function validateGhqRoot(input: string, homedir: string): { ok: true; path: string } | { ok: false; err: string } {
  if (!input) return { ok: false, err: "Path must be absolute" };
  if (!input.startsWith("/") && !input.startsWith("~")) {
    return { ok: false, err: "Path must be absolute (start with / or ~)" };
  }
  const expanded = input.startsWith("~") ? input.replace(/^~/, homedir) : input;
  return { ok: true, path: expanded };
}

export function validatePeerUrl(url: string): string | null {
  if (!url) return "URL required";
  if (!/^https?:\/\//.test(url)) return "URL must start with http:// or https://";
  try {
    new URL(url);
    return null;
  } catch {
    return `Invalid URL: ${url}`;
  }
}

export function validatePeerName(name: string): string | null {
  if (!PEER_NAME_RE.test(name)) {
    return "Name must be 1-31 chars, letters/digits/hyphens only";
  }
  return null;
}

export interface PromptAnswers {
  node: string;
  token: string;
  federate: boolean;
  peers: { name: string; url: string }[];
}

const MAX_ATTEMPTS = 3;

async function askUntilValid(
  ask: AskFn,
  question: string,
  defaultVal: string,
  validate: (v: string) => string | null,
  writer: (msg: string) => void,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const answer = await ask(question, defaultVal);
    const err = validate(answer);
    if (!err) return answer;
    writer(`  \x1b[31m✗\x1b[0m ${err}`);
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`Aborted after ${MAX_ATTEMPTS} invalid attempts: ${question}`);
    }
  }
  throw new Error("unreachable");
}

export async function runPromptLoop(
  ask: AskFn,
  defaults: { node: string },
  homedir: string,
  writer: (msg: string) => void,
): Promise<PromptAnswers> {
  // #680 — ghq root is no longer prompted; it's resolved on demand via `ghq root`.
  void homedir; // kept in signature for backward-compat (callers still pass it)
  const node = await askUntilValid(
    ask,
    "Node name (this machine's identity in the federation)",
    defaults.node,
    validateNodeName,
    writer,
  );

  const token = await ask("Claude token (blank = use $CLAUDE_CODE_OAUTH_TOKEN or ~/.claude/credentials)", "");
  if (!token && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    writer(`  \x1b[33m!\x1b[0m no token provided and $CLAUDE_CODE_OAUTH_TOKEN not set — set it before running 'maw wake'`);
  }

  const federateAnswer = (await ask("Federate with other machines? (y/N)", "N")).toLowerCase();
  const federate = federateAnswer === "y" || federateAnswer === "yes";

  const peers: { name: string; url: string }[] = [];
  if (federate) {
    let idx = 1;
    while (true) {
      const url = await ask(`Peer ${idx} URL`, "done");
      if (!url || url === "done") break;
      const urlErr = validatePeerUrl(url);
      if (urlErr) {
        writer(`  \x1b[31m✗\x1b[0m ${urlErr}`);
        continue;
      }
      const name = await askUntilValid(
        ask,
        `Peer ${idx} name (short label)`,
        `peer-${idx}`,
        validatePeerName,
        writer,
      );
      peers.push({ name, url });
      idx++;
    }
  }

  return { node, token, federate, peers };
}
