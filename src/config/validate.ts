import type { MawConfig } from "./types";

/** @internal Validates basic scalar/map fields: host, port, ghqRoot, oracleUrl, env, commands, sessions, tmuxSocket */
export function validateBasicFields(
  raw: Record<string, unknown>,
  result: Record<string, unknown>,
  warn: (field: string, msg: string) => void
): void {
  // host: string, non-empty
  if ("host" in raw) {
    if (typeof raw.host === "string" && raw.host.trim().length > 0) {
      result.host = raw.host.trim();
    } else {
      warn("host", "must be a non-empty string");
    }
  }

  // bind: string (#713) — API server bind address, separate from outbound host
  if ("bind" in raw) {
    if (typeof raw.bind === "string" && raw.bind.trim().length > 0) {
      result.bind = raw.bind.trim();
    } else {
      warn("bind", "must be a non-empty string");
    }
  }

  // port: number, 1-65535
  if ("port" in raw) {
    const p = Number(raw.port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) {
      result.port = p;
    } else {
      warn("port", "must be an integer 1-65535");
    }
  }

  // ghqRoot: string
  if ("ghqRoot" in raw) {
    if (typeof raw.ghqRoot === "string" && raw.ghqRoot.length > 0) {
      result.ghqRoot = raw.ghqRoot;
    } else {
      warn("ghqRoot", "must be a non-empty string");
    }
  }

  // oracleUrl: string
  if ("oracleUrl" in raw) {
    if (typeof raw.oracleUrl === "string" && raw.oracleUrl.length > 0) {
      result.oracleUrl = raw.oracleUrl;
    } else {
      warn("oracleUrl", "must be a non-empty string");
    }
  }

  // env: Record<string, string>
  if ("env" in raw) {
    if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
      result.env = raw.env;
    } else {
      warn("env", "must be an object");
    }
  }

  // commands: Record<string, string>, must have "default" if present
  if ("commands" in raw) {
    if (raw.commands && typeof raw.commands === "object" && !Array.isArray(raw.commands)) {
      const cmds = raw.commands as Record<string, unknown>;
      if (!("default" in cmds) || typeof cmds.default !== "string") {
        warn("commands", "must include a 'default' string entry");
      } else {
        result.commands = cmds as Record<string, string>;
      }
    } else {
      warn("commands", "must be an object");
    }
  }

  // engines: Record<string, EngineDef> (#1960 P1). Dormant typed surface; keep
  // validation intentionally light so future optional EngineDef fields can roll
  // out without rejecting existing config.
  if ("engines" in raw) {
    if (raw.engines && typeof raw.engines === "object" && !Array.isArray(raw.engines)) {
      const engines: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(raw.engines as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          warn(`engines.${name}`, "must be an object");
          continue;
        }
        const def = value as Record<string, unknown>;
        if (typeof def.cmd !== "string" || def.cmd.trim().length === 0) {
          warn(`engines.${name}.cmd`, "must be a non-empty string");
          continue;
        }
        if (def.processNames !== undefined && (!Array.isArray(def.processNames) || def.processNames.some((v) => typeof v !== "string"))) {
          warn(`engines.${name}.processNames`, "must be a string[]");
          continue;
        }
        engines[name] = { ...def, name: typeof def.name === "string" && def.name ? def.name : name };
      }
      if (Object.keys(engines).length > 0) result.engines = engines;
    } else {
      warn("engines", "must be an object");
    }
  }

  // sessions: Record<string, string>
  if ("sessions" in raw) {
    if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
      result.sessions = raw.sessions;
    } else {
      warn("sessions", "must be an object");
    }
  }

  // tmuxSocket: string if present
  if ("tmuxSocket" in raw) {
    if (typeof raw.tmuxSocket === "string") {
      result.tmuxSocket = raw.tmuxSocket;
    } else {
      warn("tmuxSocket", "must be a string");
    }
  }
}

/** Validate config shape with native TS checks (no Zod).
 *  Returns array of error strings — empty means valid. */
export function validateConfigShape(config: unknown): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") return ["Config must be an object"];
  const c = config as Record<string, unknown>;

  if (c.host !== undefined && typeof c.host !== "string") errors.push("host must be a string");
  if (c.bind !== undefined && typeof c.bind !== "string") errors.push("bind must be a string");
  if (c.port !== undefined) {
    if (typeof c.port !== "number" || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
      errors.push("port must be an integer 1-65535");
  }
  if (c.ghqRoot !== undefined && typeof c.ghqRoot !== "string") errors.push("ghqRoot must be a string");
  if (c.oracleUrl !== undefined && typeof c.oracleUrl !== "string") errors.push("oracleUrl must be a string");
  if (c.tmuxSocket !== undefined && typeof c.tmuxSocket !== "string") errors.push("tmuxSocket must be a string");
  if (c.federationToken !== undefined && typeof c.federationToken !== "string") errors.push("federationToken must be a string");
  if (c.scout !== undefined && typeof c.scout !== "boolean") errors.push("scout must be a boolean");

  if (c.errorForward !== undefined) {
    if (!c.errorForward || typeof c.errorForward !== "object" || Array.isArray(c.errorForward)) {
      errors.push("errorForward must be an object");
    } else {
      const errorForward = c.errorForward as Record<string, unknown>;
      if (errorForward.target !== undefined && typeof errorForward.target !== "string") {
        errors.push("errorForward.target must be a string");
      }
    }
  }

  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== "object" || Array.isArray(c.env)) {
      errors.push("env must be a Record<string, string>");
    } else {
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        if (typeof v !== "string") errors.push(`env.${k} must be a string`);
      }
    }
  }

  if (c.commands !== undefined) {
    if (!c.commands || typeof c.commands !== "object" || Array.isArray(c.commands)) {
      errors.push("commands must be a Record<string, string>");
    } else {
      for (const [k, v] of Object.entries(c.commands as Record<string, unknown>)) {
        if (typeof v !== "string") errors.push(`commands.${k} must be a string`);
      }
    }
  }

  if (c.engines !== undefined) {
    if (!c.engines || typeof c.engines !== "object" || Array.isArray(c.engines)) {
      errors.push("engines must be a Record<string, EngineDef>");
    } else {
      for (const [k, v] of Object.entries(c.engines as Record<string, unknown>)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          errors.push(`engines.${k} must be an object`);
          continue;
        }
        const def = v as Record<string, unknown>;
        if (def.name !== undefined && typeof def.name !== "string") errors.push(`engines.${k}.name must be a string`);
        if (typeof def.cmd !== "string" || def.cmd.length === 0) errors.push(`engines.${k}.cmd must be a non-empty string`);
        if (def.processNames !== undefined && (!Array.isArray(def.processNames) || def.processNames.some((item) => typeof item !== "string"))) {
          errors.push(`engines.${k}.processNames must be a string[]`);
        }
      }
    }
  }

  if (c.limits !== undefined) {
    if (!c.limits || typeof c.limits !== "object" || Array.isArray(c.limits)) {
      errors.push("limits must be a Record<string, number>");
    } else {
      for (const [k, v] of Object.entries(c.limits as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors.push(`limits.${k} must be a number >= 0`);
      }
    }
  }

  if (c.sessions !== undefined) {
    if (!c.sessions || typeof c.sessions !== "object" || Array.isArray(c.sessions)) {
      errors.push("sessions must be a Record<string, string>");
    } else {
      for (const [k, v] of Object.entries(c.sessions as Record<string, unknown>)) {
        if (typeof v !== "string") errors.push(`sessions.${k} must be a string`);
      }
    }
  }

  if (c.peers !== undefined) {
    if (!Array.isArray(c.peers)) {
      errors.push("peers must be a string[]");
    } else {
      for (let i = 0; i < c.peers.length; i++) {
        if (typeof c.peers[i] !== "string") errors.push(`peers[${i}] must be a string`);
      }
    }
  }

  return errors;
}
