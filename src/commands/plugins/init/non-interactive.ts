import { parseFlags } from "../../../cli/parse-args";
import { validateNodeName, validateGhqRoot, validatePeerUrl, validatePeerName } from "./prompts";

export interface NonInteractiveOpts {
  node: string;
  ghqRoot: string;
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

export function parseNonInteractive(args: string[], homedir: string, defaults: { node: string; ghqRoot: string }): NonInteractiveResult {
  // arg's String type collapses repeated flags; use [String] for arrays.
  const flags = parseFlags(args, {
    "--non-interactive": Boolean,
    "--node": String,
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

  const ghqRaw = flags["--ghq-root"] ?? defaults.ghqRoot;
  const ghqV = validateGhqRoot(ghqRaw, homedir);
  if (!ghqV.ok) return { ok: false, error: ghqV.err };

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
      ghqRoot: ghqV.path,
      token: flags["--token"],
      federate,
      peers,
      federationToken: flags["--federation-token"],
      force: !!flags["--force"],
      backup: !!flags["--backup"],
    },
  };
}
