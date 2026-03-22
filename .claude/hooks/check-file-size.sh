#!/bin/bash
# Warn when a file exceeds line count threshold after Edit/Write
set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | /usr/bin/jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | /usr/bin/jq -r '.tool_input.file_path // empty')

# Only check Write and Edit
if [[ "$TOOL_NAME" != "Write" && "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

# Skip if file doesn't exist
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

LINE_COUNT=$(wc -l < "$FILE_PATH" 2>/dev/null || echo "0")
THRESHOLD=200
FILENAME=$(basename "$FILE_PATH")

if [ "$LINE_COUNT" -gt "$THRESHOLD" ]; then
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"FILE SIZE WARNING: $FILENAME has $LINE_COUNT lines (threshold: $THRESHOLD). Consider splitting into smaller components/modules.\"}}"
fi

exit 0
