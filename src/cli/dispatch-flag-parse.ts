/**
 * #1885 — parse plugin CLI flags from raw argv per the manifest-declared
 * `cli.flags` schema. Pure function — no imports beyond TS types, no
 * side effects, no config/loader dependencies. Safe to use from any
 * dispatch site without cascading test-mock surfaces.
 *
 * Contract:
 *   • Walk argv left-to-right; stop at `--` separator
 *   • Only flags declared in the schema are parsed (unknown flags are
 *     skipped — `validatePluginCliFlags` already rejected unknowns before
 *     this point, so any unknown reaching here is a sign of a layer-skip)
 *   • Boolean flags set true when present (no value consumed)
 *   • String/number/string[] flags consume the next arg or split on `=`
 *   • Result keys strip leading `--` (e.g. `--team-id` → `team-id`)
 *   • Repeated string flag → last-wins; repeated boolean → still true;
 *     repeated string[] → all values collected in order
 *   • Missing value for non-boolean flag → silently skip (matches
 *     `validatePluginCliFlags`'s permissive treatment)
 *   • Non-numeric value for "number" flag → silently skip
 */

export type ManifestFlagType = "boolean" | "string" | "number" | "string[]";

export type ParsedPluginFlags = Record<string, boolean | string | number | string[]>;

function stripDash(name: string): string {
  return name.replace(/^--?/, "");
}

export function parsePluginFlags(
  declared: Record<string, ManifestFlagType>,
  argv: string[],
): ParsedPluginFlags {
  const out: ParsedPluginFlags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    if (arg.length <= 1) continue;
    if (/^-\d/.test(arg)) continue;  // negative numbers, not flags

    const eqIdx = arg.indexOf("=");
    const rawName = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inlineValue = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);

    const type = declared[rawName];
    if (!type) continue;

    const key = stripDash(rawName);

    if (type === "boolean") {
      out[key] = true;
      continue;
    }

    let value: string | undefined;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (i + 1 < argv.length) {
      value = argv[i + 1]!;
      i++;
    }
    if (value === undefined) continue;

    if (type === "string") {
      out[key] = value;
    } else if (type === "number") {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    } else if (type === "string[]") {
      const existing = out[key];
      if (Array.isArray(existing)) existing.push(value);
      else out[key] = [value];
    }
  }

  return out;
}
