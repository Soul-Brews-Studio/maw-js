/**
 * registry-oracle-types — OracleEntry, RegistryCache types and shared constants.
 */

import { mawCachePath, mawConfigPath } from "../xdg";

export interface OracleEntry {
  org: string;
  repo: string;
  name: string;            // display name: strip trailing -oracle
  local_path: string;
  has_psi: boolean;
  has_fleet_config: boolean;
  budded_from: string | null;
  budded_at: string | null;
  federation_node: string | null;
  detected_at: string;     // ISO8601
  // Optional human-chosen label, authoritative source is <local_path>/ψ/nickname.
  // Not persisted to oracles.json — populated in-memory via read-through cache.
  nickname?: string;
}

export interface RegistryCache {
  schema: 1;
  local_scanned_at: string;
  ghq_root: string;
  oracles: OracleEntry[];
}

export function registryCacheFilePath(): string {
  return mawCachePath("oracles.json");
}

export function legacyRegistryCacheFilePath(): string {
  return mawConfigPath("oracles.json");
}

export const CACHE_FILE = registryCacheFilePath();
export const LEGACY_CACHE_FILE = legacyRegistryCacheFilePath();
export const STALE_HOURS = 1;
