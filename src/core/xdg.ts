import { homedir } from "os";
import { isAbsolute, join } from "path";

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function absoluteEnv(name: string): string | null {
  const value = process.env[name];
  if (!value) return null;
  return isAbsolute(value) ? value : null;
}

function legacyHome(): string {
  return join(homedir(), ".maw");
}

function xdgBase(envName: string, ...fallback: string[]): string {
  return absoluteEnv(envName) ?? join(homedir(), ...fallback);
}

export function isMawXdgEnabled(): boolean {
  return truthyEnv(process.env.MAW_XDG);
}

export function mawConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  if (process.env.MAW_CONFIG_DIR) return process.env.MAW_CONFIG_DIR;
  return join(xdgBase("XDG_CONFIG_HOME", ".config"), "maw");
}

export function mawRuntimeHomeDir(): string {
  if (process.env.MAW_HOME) return process.env.MAW_HOME;
  return isMawXdgEnabled()
    ? mawStateDir()
    : legacyHome();
}

export function mawDataDir(): string {
  if (process.env.MAW_HOME) return process.env.MAW_HOME;
  if (process.env.MAW_DATA_DIR) return process.env.MAW_DATA_DIR;
  return isMawXdgEnabled()
    ? join(xdgBase("XDG_DATA_HOME", ".local", "share"), "maw")
    : legacyHome();
}

export function mawStateDir(): string {
  if (process.env.MAW_HOME) return process.env.MAW_HOME;
  if (process.env.MAW_STATE_DIR) return process.env.MAW_STATE_DIR;
  return isMawXdgEnabled()
    ? join(xdgBase("XDG_STATE_HOME", ".local", "state"), "maw")
    : legacyHome();
}

export function mawCacheDir(): string {
  if (process.env.MAW_HOME) return process.env.MAW_HOME;
  if (process.env.MAW_CACHE_DIR) return process.env.MAW_CACHE_DIR;
  return isMawXdgEnabled()
    ? join(xdgBase("XDG_CACHE_HOME", ".cache"), "maw")
    : legacyHome();
}

export function mawConfigPath(...parts: string[]): string {
  return join(mawConfigDir(), ...parts);
}

export function mawDataPath(...parts: string[]): string {
  return join(mawDataDir(), ...parts);
}

export function mawStatePath(...parts: string[]): string {
  return join(mawStateDir(), ...parts);
}

export function mawCachePath(...parts: string[]): string {
  return join(mawCacheDir(), ...parts);
}
