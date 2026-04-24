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
