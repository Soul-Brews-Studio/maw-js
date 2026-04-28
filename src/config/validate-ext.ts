import type { MawConfig } from "./types";
import { validateBasicFields } from "./validate";

/** @internal Validates extended fields: triggers, federation, plugins, peers, node, etc. */
function validateExtFields(
  raw: Record<string, unknown>,
  result: Record<string, unknown>,
  warn: (field: string, msg: string) => void
): void {
  // triggers: TriggerConfig[]
  if ("triggers" in raw) {
    if (Array.isArray(raw.triggers)) {
      const valid = raw.triggers.filter((t: any) => {
        if (!t || typeof t !== "object") return false;
        if (!t.on || typeof t.on !== "string") return false;
        if (!t.action || typeof t.action !== "string") return false;
        return true;
      });
      if (valid.length !== raw.triggers.length) {
        warn("triggers", `has ${raw.triggers.length - valid.length} invalid entries, keeping valid ones`);
      }
      result.triggers = valid;
    } else {
      warn("triggers", "must be an array");
    }
  }

  // federationToken: string, min 16 chars
  if ("federationToken" in raw) {
    if (typeof raw.federationToken === "string" && raw.federationToken.length >= 16) {
      result.federationToken = raw.federationToken;
    } else if (typeof raw.federationToken === "string") {
      warn("federationToken", "must be at least 16 characters");
    } else {
      warn("federationToken", "must be a string");
    }
  }

  // allowPeersWithoutToken: boolean, explicit opt-in to legacy open posture.
  // Without this passthrough the field is silently stripped in production
  // (review feedback from mawjs on #396), making the escape hatch unreachable
  // via maw.config.json while still reachable in tests — a UX bug where
  // runtime posture is stricter-than-advertised.
  if ("allowPeersWithoutToken" in raw) {
    if (typeof raw.allowPeersWithoutToken === "boolean") {
      result.allowPeersWithoutToken = raw.allowPeersWithoutToken;
    } else {
      warn("allowPeersWithoutToken", "must be a boolean");
    }
  }

  // trustLoopback: boolean. Defaults to `true` if unset (preserves legacy
  // behavior — local CLI calls work without signing). Operators who run
  // behind a local reverse proxy MUST set this to false (closes Path B
  // from #191). See src/config/types.ts for the full threat model.
  if ("trustLoopback" in raw) {
    if (typeof raw.trustLoopback === "boolean") {
      result.trustLoopback = raw.trustLoopback;
    } else {
      warn("trustLoopback", "must be a boolean");
    }
  }

  // pin: string if present
  if ("pin" in raw) {
    if (typeof raw.pin === "string") {
      result.pin = raw.pin;
    } else {
      warn("pin", "must be a string");
    }
  }

  // pluginSources: string[] of URLs
  if ("pluginSources" in raw) {
    if (Array.isArray(raw.pluginSources)) {
      result.pluginSources = (raw.pluginSources as unknown[]).filter(s => typeof s === "string") as string[];
    } else {
      warn("pluginSources", "must be an array of URL strings");
    }
  }

  // disabledPlugins: string[] of plugin names
  if ("disabledPlugins" in raw) {
    if (Array.isArray(raw.disabledPlugins)) {
      result.disabledPlugins = (raw.disabledPlugins as unknown[]).filter(s => typeof s === "string") as string[];
    } else {
      warn("disabledPlugins", "must be an array of plugin names");
    }
  }

  // node: string if present
  if ("node" in raw) {
    if (typeof raw.node === "string" && raw.node.trim().length > 0) {
      result.node = raw.node.trim();
    } else {
      warn("node", "must be a non-empty string");
    }
  }

  // oracle: string if present (#804 Step 4 SIGN — v3 from-address prefix)
  if ("oracle" in raw) {
    if (typeof raw.oracle === "string" && raw.oracle.trim().length > 0) {
      result.oracle = raw.oracle.trim();
    } else {
      warn("oracle", "must be a non-empty string");
    }
  }

  // namedPeers: array of {name, url} objects
  if ("namedPeers" in raw) {
    if (Array.isArray(raw.namedPeers)) {
      const valid = raw.namedPeers.filter((p: any) => {
        if (!p || typeof p !== "object") return false;
        if (typeof p.name !== "string" || typeof p.url !== "string") return false;
        try { new URL(p.url); return true; } catch { return false; }
      });
      if (valid.length !== raw.namedPeers.length) {
        warn("namedPeers", `has ${raw.namedPeers.length - valid.length} invalid entries`);
      }
      result.namedPeers = valid;
    } else {
      warn("namedPeers", "must be an array of {name, url}");
    }
  }

  // agents: Record<string, string> (agent name → node name)
  if ("agents" in raw) {
    if (raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents)) {
      result.agents = raw.agents;
    } else {
      warn("agents", "must be an object mapping agent names to node names");
    }
  }

  // peers: array of valid URLs if present
  if ("peers" in raw) {
    if (Array.isArray(raw.peers)) {
      const valid = raw.peers.filter((p) => {
        if (typeof p !== "string") return false;
        try { new URL(p); return true; } catch { return false; }
      });
      if (valid.length !== raw.peers.length) {
        warn("peers", `has ${raw.peers.length - valid.length} invalid URL(s), keeping valid ones`);
      }
      result.peers = valid;
    } else {
      warn("peers", "must be an array of URLs");
    }
  }

  // githubOrg: string (#204)
  if ("githubOrg" in raw && typeof raw.githubOrg === "string") {
    result.githubOrg = raw.githubOrg;
  }

  // nanoclaw: pass through (bridge config)
  if ("nanoclaw" in raw && raw.nanoclaw && typeof raw.nanoclaw === "object") {
    result.nanoclaw = raw.nanoclaw;
  }
}

/** Validate config values, warn on invalid fields, return sanitized config */
export function validateConfig(raw: Record<string, unknown>): Partial<MawConfig> {
  const result: Record<string, unknown> = {};
  const warn = (field: string, msg: string) =>
    console.warn(`[maw] config warning: ${field} ${msg}, using default`);
  validateBasicFields(raw, result, warn);
  validateExtFields(raw, result, warn);
  return result as Partial<MawConfig>;
}
