#!/usr/bin/env bash
# scripts/test-default-safe-selftest.sh — kobo-531: prove test-default-safe.sh
# runs every declared case even when an earlier one fails, instead of
# `set -e` bailing out right after the first red file and silently skipping
# whatever was still queued.
#
# Before the fix: the shared sweep failing hard-exits the script via `set -e`
#                  — the mock-isolated cases queued after it never execute at
#                  all (only reported as "NEVER RAN" by the kobo-476 EXIT
#                  trap, which only reports the skip, never prevents it).
#                  This script FAILS.
# After the fix:   every case still runs to completion regardless of an
#                  earlier case's outcome, and the script's own exit code
#                  still reflects the failure. This script PASSES.
#
# Isolation: synthetic *.test.ts fixtures are written to a private tmpdir
# and passed as explicit file args (REQUESTED_FILES mode) — nothing here
# touches the real test suite.

set -euo pipefail
cd "$(dirname "$0")/.."

FIXTURES="$(mktemp -d)"
OUT="$(mktemp)"
cleanup() { rm -rf "$FIXTURES" "$OUT"; }
trap cleanup EXIT

cat > "$FIXTURES/plain-fail.test.ts" <<'EOF'
import { test, expect } from "bun:test";
// kobo-531 selftest fixture — deliberately red, so the shared sweep has a
// real failure to trip on (AC1: "make the first file red for real").
test("kobo-531 selftest: deliberate failure", () => {
  expect(1).toBe(2);
});
EOF

# kobo-531 round 2 (head review): the fixtures below used to be green-only, so
# the MOCK LOOP's own `|| OVERALL_RC=$?` (test-default-safe.sh:345) was never
# exercised — deleting it left this selftest green while the original bug came
# straight back on that leg. This fixture is a RED mock, and it must sort
# BEFORE the green ones: test-default-safe.sh derives MOCK_FILES through
# `sort -u`, so ordering comes from the FILENAME, not from argument order.
# A leading digit sorts ahead of a letter, and the ordering is asserted below
# rather than assumed.
cat > "$FIXTURES/mock-1-fail.test.ts" <<'EOF'
import { test, expect, mock } from "bun:test";
mock.module("node:os", () => ({ hostname: () => "kobo-531-selftest-red" }));
// Deliberately red, and mock-isolated, so the failure lands INSIDE the mock
// loop rather than in the shared sweep.
test("kobo-531 selftest: mock-isolated file that fails", () => {
  expect(1).toBe(2);
});
EOF

cat > "$FIXTURES/mock-a.test.ts" <<'EOF'
import { test, expect, mock } from "bun:test";
mock.module("node:os", () => ({ hostname: () => "kobo-531-selftest-a" }));
test("kobo-531 selftest: mock-isolated file a still runs", () => {
  expect(true).toBe(true);
});
EOF

cat > "$FIXTURES/mock-b.test.ts" <<'EOF'
import { test, expect, mock } from "bun:test";
mock.module("node:os", () => ({ hostname: () => "kobo-531-selftest-b" }));
test("kobo-531 selftest: mock-isolated file b still runs", () => {
  expect(true).toBe(true);
});
EOF

set +e
bash scripts/test-default-safe.sh \
  "$FIXTURES/plain-fail.test.ts" \
  "$FIXTURES/mock-1-fail.test.ts" \
  "$FIXTURES/mock-a.test.ts" \
  "$FIXTURES/mock-b.test.ts" \
  > "$OUT" 2>&1
RC=$?
set -e

echo "--- captured test-default-safe.sh output (exit $RC) ---"
cat "$OUT"
echo "--- end captured output ---"

FAIL=0

# AC1: the shared sweep (containing plain-fail.test.ts) must actually fail —
# a zero exit here means the deliberate failure above didn't even run.
if [[ "$RC" -eq 0 ]]; then
  echo "FAIL: expected a non-zero exit (plain-fail.test.ts should fail the shared sweep), got 0" >&2
  FAIL=1
fi

# AC2: both mock-isolated files must have ACTUALLY STARTED (not just been
# reported as skipped) — look for each one's own "--- <path> ---" marker,
# which test-default-safe.sh only prints right before it invokes that case.
if ! grep -q -- "--- $FIXTURES/mock-a.test.ts ---" "$OUT"; then
  echo "FAIL: mock-a.test.ts case never started — a later case is still being skipped after an earlier failure" >&2
  FAIL=1
fi
if ! grep -q -- "--- $FIXTURES/mock-b.test.ts ---" "$OUT"; then
  echo "FAIL: mock-b.test.ts case never started" >&2
  FAIL=1
fi
# AC3 (kobo-531 round 2): the same must hold when the failing case is INSIDE
# the mock loop, not just in the shared sweep — that is the leg
# test-default-safe.sh:345 guards, and nothing exercised it before.
# The check is not "the red mock ran" on its own: it is "the red mock ran
# FIRST and the green ones still ran after it". Ordering is asserted, not
# assumed, because MOCK_FILES comes out of `sort -u` — if a rename or a locale
# change ever puts the red fixture last, this fails loudly instead of quietly
# testing nothing.
RED_LINE="$(grep -n -- "--- $FIXTURES/mock-1-fail.test.ts ---" "$OUT" | head -1 | cut -d: -f1)"
LAST_GREEN_LINE="$(grep -n -- "--- $FIXTURES/mock-b.test.ts ---" "$OUT" | head -1 | cut -d: -f1)"
if [[ -z "$RED_LINE" ]]; then
  echo "FAIL: mock-1-fail.test.ts case never started — the mock loop is not reaching a failing mock-isolated file at all" >&2
  FAIL=1
elif [[ -z "$LAST_GREEN_LINE" ]]; then
  echo "FAIL: mock-b.test.ts never started after the failing mock-isolated case — a red case inside the mock loop is still killing the cases queued behind it" >&2
  FAIL=1
elif [[ "$RED_LINE" -ge "$LAST_GREEN_LINE" ]]; then
  echo "FAIL: fixture ordering broke — mock-1-fail.test.ts ran at line $RED_LINE, AFTER mock-b.test.ts at line $LAST_GREEN_LINE. MOCK_FILES is sorted by filename, so the red fixture must sort first or this check proves nothing." >&2
  FAIL=1
fi

if grep -q "NEVER RAN" "$OUT"; then
  echo "FAIL: output still reports cases as NEVER RAN — the early-exit-and-report behavior is still active, not fixed" >&2
  FAIL=1
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "" >&2
  echo "FAIL: kobo-531 selftest — test-default-safe.sh still stops at the first red case" >&2
  exit 1
fi

echo "PASS: shared-sweep failure surfaced (exit $RC) AND both mock-isolated cases still ran to completion"
