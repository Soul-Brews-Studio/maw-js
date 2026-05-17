#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf coverage
MAW_TEST_MODE=1 bun test test/ \
  --coverage \
  --coverage-reporter=text \
  --coverage-reporter=lcov \
  --coverage-dir=coverage \
  --path-ignore-patterns '**/test/isolated/**' \
  --path-ignore-patterns '**/zz-mock-tmux-smoke*' \
  --path-ignore-patterns '**/agents/**'

bun scripts/coverage-gap-analysis.ts coverage/lcov.info docs/testing/coverage-gap-analysis.md
bun scripts/coverage-badge.ts coverage/lcov.info coverage/maw-js-coverage.json
