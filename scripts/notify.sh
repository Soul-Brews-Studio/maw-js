#!/bin/bash
#
# notify.sh - Universal notification sender for all agents
#
# Usage:
#   ./notify.sh "Task Created" "Starting analysis..." "mqtt" "task_created"
#   ./notify.sh "Error" "Something went wrong" "mqtt" "error" "agent:trade-lead"
#
# Environment:
#   NOTIFICATION_API_URL - default: http://localhost:3456
#

set -e

API_URL="${NOTIFICATION_API_URL:-http://localhost:3456}"

# Parse arguments
TITLE="$1"
MESSAGE="$2"
CHANNEL="${3:-mqtt}"
TYPE="${4:-info}"
METADATA="${5:-}"

# Validate required arguments
if [ -z "$TITLE" ] || [ -z "$MESSAGE" ]; then
  echo "❌ Error: TITLE and MESSAGE are required" >&2
  echo "" >&2
  echo "Usage: $0 TITLE MESSAGE [CHANNEL] [TYPE] [METADATA_JSON]" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 'Task Created' 'Starting market analysis' 'mqtt' 'task_created'" >&2
  echo "  $0 'Error' 'Data fetch failed' 'mqtt' 'error' '{\"agent\":\"trade-lead\"}'" >&2
  echo "  $0 'Need Advice' 'Best strategy for BTC?' 'threads' 'consultation'" >&2
  exit 1
fi

# Limit lengths
TITLE_TRUNCATED="${TITLE:0:200}"
MESSAGE_TRUNCATED="${MESSAGE:0:1000}"

# Build JSON payload
if [ -n "$METADATA" ]; then
  JSON_PAYLOAD=$(cat <<EOF
{
  "channel": "$CHANNEL",
  "type": "$TYPE",
  "title": "$TITLE_TRUNCATED",
  "message": "$MESSAGE_TRUNCATED",
  "metadata": $METADATA
}
EOF
)
else
  JSON_PAYLOAD=$(cat <<EOF
{
  "channel": "$CHANNEL",
  "type": "$TYPE",
  "title": "$TITLE_TRUNCATED",
  "message": "$MESSAGE_TRUNCATED"
}
EOF
)
fi

# Send notification
RESPONSE=$(curl -s -X POST "$API_URL/api/notifications/notify" \
  -H "Content-Type: application/json" \
  -d "$JSON_PAYLOAD")

# Check response
if echo "$RESPONSE" | jq -e '.ok' > /dev/null 2>&1; then
  NOTIF_ID=$(echo "$RESPONSE" | jq -r '.notification.id')
  echo "✅ Notification sent: $NOTIF_ID"
  exit 0
else
  echo "❌ Failed to send notification" >&2
  echo "$RESPONSE" >&2
  exit 1
fi
