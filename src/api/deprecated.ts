// deprecated.ts — proper 410 Gone rotation for retired endpoints
//
// Author: FORGE Oracle — 2026-04-18
// Rationale: VELA's silent-errors-deprecated-endpoints pattern (~/david-oracle/
// ψ/memory/vela/patterns/2026-04-18_silent-errors-deprecated-endpoints.md).
// Previous cleanup commit b0b0de2 removed the stub-corpse handlers, but that
// produced silent 404s from the framework instead of a loud deprecation signal.
// This restores handlers that issue 410 Gone with RFC-compliant migration
// metadata (Link, Deprecation, Sunset headers) pointing at the replacement.
//
// Three routes covered:
//   GET /api/tokens       → 410 + Link: /api/feed      (was: 410 no-link)
//   GET /api/tokens/rate  → 410 + Link: /api/costs     (was: 200 zero-stub)
//   GET /api/maw-log      → 410 + Link: /api/feed      (was: 200 empty-stub)

import { Elysia } from "elysia";

const SUNSET = "2026-05-01"; // hard cutoff; route removal after this date

interface DeprecatedBody {
  error: "removed";
  replacement: string;
  sunset: string;
  message: string;
}

function gone(set: { status: number; headers: Record<string, string> }, replacement: string): DeprecatedBody {
  set.status = 410;
  set.headers["Link"] = `<${replacement}>; rel="alternate"`;
  set.headers["Deprecation"] = "true";
  set.headers["Sunset"] = SUNSET;
  return {
    error: "removed",
    replacement,
    sunset: SUNSET,
    message: `This endpoint was removed. Use ${replacement} instead.`,
  };
}

export const deprecatedApi = new Elysia();

deprecatedApi.get("/tokens", ({ set }) => gone(set, "/api/feed"));
deprecatedApi.get("/tokens/rate", ({ set }) => gone(set, "/api/costs"));
deprecatedApi.get("/maw-log", ({ set }) => gone(set, "/api/feed"));
