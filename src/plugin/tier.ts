import type { PluginTier } from "./types";

export function weightToTier(weight: number): PluginTier {
  if (weight < 10) return "core";
  if (weight < 50) return "standard";
  return "extra";
}
