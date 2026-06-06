export interface ProvenanceEntry {
  path: string;
  weight: number;
  scope: string;
  isLocal: boolean;
  value: unknown;
  action: "set" | "delete";
}

export type ProvenanceMap = Record<string, ProvenanceEntry[]>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinKey(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown> | null | undefined,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === null) {
      delete result[key];
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value);
    } else if (isPlainObject(value)) {
      result[key] = deepMerge({}, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export function recordProvenance(
  provenance: ProvenanceMap,
  source: { path: string; weight: number; scope: string; isLocal: boolean },
  value: Record<string, unknown> | null | undefined,
  parent = "",
): void {
  for (const [key, child] of Object.entries(value ?? {})) {
    const keyPath = joinKey(parent, key);
    if (child === null) {
      (provenance[keyPath] ??= []).push({ ...source, value: null, action: "delete" });
      continue;
    }
    if (isPlainObject(child)) {
      recordProvenance(provenance, source, child, keyPath);
      continue;
    }
    (provenance[keyPath] ??= []).push({ ...source, value: child, action: "set" });
  }
}
