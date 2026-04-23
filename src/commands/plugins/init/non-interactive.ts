import { parseFlags } from "../../../cli/parse-args";
import { validateNodeName, validatePeerUrl, validatePeerName } from "./prompts";

export interface NonInteractiveOpts {
  node: string;
  token?: string;
  federate: boolean;
  peers: { name: string; url: string }[];
  federationToken?: string;
  force: boolean;
  backup: boolean;
}

export type NonInteractiveResult =
  | { ok: true; opts: NonInteractiveOpts }
  | { ok: false; error: string };

export function parseNonInteractive(args: string[], homedir: string, defaults: { node: string }): NonInteractiveResult {
  void homedir; // #680 — retained for signature compat; ghqRoot no longer parsed
  // arg's String type collapses repeated flags; use [String] for arrays.
  const flags = parseFlags(args, {
    "--non-interactive": Boolean,
    "--node": String,
    // #680 — --ghq-root accepted but ignored (logs deprecation in cmdInit).
    "--ghq-root": String,
    "--token": String,
    "--federate": Boolean,
    "--peer": [String],
    "--peer-name": [String],
    "--federation-token": String,
    "--force": Boolean,
    "--backup": Boolean,
  }, 0);

  const node = flags["--node"] ?? defaults.node;
  const nodeErr = validateNodeName(node);
  if (nodeErr) return { ok: false, error: nodeErr };

  if (flags["--ghq-root"]) {
    process.stderr.write(
      `[maw init] warning: --ghq-root is deprecated (#680) and ignored — ghq root is resolved on demand.\n`,
    );
  }

  const peerUrls = (flags["--peer"] ?? []) as string[];
  const peerNames = (flags["--peer-name"] ?? []) as string[];
  const peers: { name: string; url: string }[] = [];
  for (let i = 0; i < peerUrls.length; i++) {
    const url = peerUrls[i];
    const urlErr = validatePeerUrl(url);
    if (urlErr) return { ok: false, error: `--peer #${i + 1}: ${urlErr}` };
    const name = peerNames[i] ?? `peer-${i + 1}`;
    const nameErr = validatePeerName(name);
    if (nameErr) return { ok: false, error: `--peer-name #${i + 1}: ${nameErr}` };
    peers.push({ name, url });
  }

  const federate = !!flags["--federate"] || peers.length > 0;

  return {
    ok: true,
    opts: {
      node,
      token: flags["--token"],
      federate,
      peers,
      federationToken: flags["--federation-token"],
      force: !!flags["--force"],
      backup: !!flags["--backup"],
    },
  };
}
