#!/bin/bash
# test-worktree-notify.sh - Simulate worktree agent completion notification
#
# This script simulates what a worktree agent would do when it completes:
# 1. Do some work (sleep)
# 2. Publish completion notification to MQTT
# 3. Clean up

set -e

WORKTREE_NAME="${1:-test-worktree}"
STATUS="${2:-done}"
DURATION="${3:-5}"

echo "🌳 Simulating worktree: $WORKTREE_NAME"
echo "⏱️  Duration: ${DURATION}s"
echo "📊 Status: $STATUS"
echo ""

# Simulate work
echo "🔄 Doing work..."
sleep "$DURATION"

# Publish completion notification via MQTT
echo "📡 Publishing completion notification..."
mosquitto_pub -h localhost -t "oracle/maw/worktree/${WORKTREE_NAME}/done" -m "$(cat <<EOF
{
  "worktree": "$WORKTREE_NAME",
  "status": "$STATUS",
  "duration": $DURATION,
  "agent": "$WORKTREE_NAME",
  "ts": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
)"

echo ""
echo "✅ Worktree $WORKTREE_NAME completed!"
echo ""
echo "Check maw logs for notification:"
echo "  pm2 logs maw --lines 10"
