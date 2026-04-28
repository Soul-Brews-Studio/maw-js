// Fixture for scripts/check-redos.ts — NOT imported anywhere.
// Each line below is a known ReDoS shape we want the detector to catch.
// Run: `bun scripts/check-redos.ts scripts/check-redos.test-fixture.ts`
//
// Expected: 4+ high-severity hits (A,B,D each), plus 1 info hit (C).

export const _A1 = "abc---".replace(/[-.]+$/, "");                  // A: the #823 shape
export const _A2 = "abc..".replace(/[._]+$/, "");                   // A: positive multi-char class
export const _B  = "ababab".match(/(a|b)+/);                        // B: alternation+quantifier
export const _D  = "x".match(/(.+)+/);                              // D: nested quantifiers
export const _C  = (k: string) => new RegExp(`prefix-${k}-suffix`); // C: dynamic RegExp (info)

// Escape-hatch checks — these should be SKIPPED:
export const _ok1 = "x".replace(/[-.]+$/, "");  // CODEQL_OK: fixture line, ignored
export const _ok2 = "x".match(/(a|b)+/);  // CODEQL_OK: fixture line, ignored
