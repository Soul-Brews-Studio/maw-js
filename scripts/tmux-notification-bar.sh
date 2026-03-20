#!/bin/bash
#
# TMUX Notification Bar
#
# Displays real-time notifications in tmux status bar
# Shows latest unread notification count per channel
#
# Usage:
#   1. Add this to your agent's startup script
#   2. Or run: source /path/to/tmux-notification-bar.sh
#

NOTIFICATION_API="${NOTIFICATION_API_URL:-http://localhost:3456}"

# Colors for tmux
COLOUR_MQTT="#[fg=colour10]📡#[default]"
COLOUR_THREADS="#[fg=colour13]💬#[default]"
COLOUR_MEMORY="#[colour11]🧠#[default]"
COLOUR_UNREAD="#[fg=colour9]#[bold]"
COLOUR_SEPARATOR="|"

# Cache previous counts to detect changes
PREV_MQTT=0
PREV_THREADS=0
PREV_MEMORY=0

# Update interval in seconds
UPDATE_INTERVAL=${TMUX_NOTIFICATION_INTERVAL:-5}

get_notification_counts() {
  local stats
  local mqtt=0 threads=0 memory=0

  # Fetch stats from API
  stats=$(curl -s "$NOTIFICATION_API/api/notifications/stats" 2>/dev/null)

  if [ -n "$stats" ]; then
    # Parse JSON using basic string manipulation (no jq dependency)
    mqtt=$(echo "$stats" | grep -o '"mqtt":[0-9]*' | grep -o '[0-9]*' | head -1)
    threads=$(echo "$stats" | grep -o '"threads":[0-9]*' | grep -o '[0-9]*' | head -1)
    memory=$(echo "$stats" | grep -o '"memory":[0-9]*' | grep -o '[0-9]*' | head -1)
  fi

  # Default to 0 if parsing failed
  echo "${mqtt:-0} ${threads:-0} ${memory:-0}"
}

update_status_bar() {
  local counts=($(get_notification_counts))
  local mqtt=${counts[0]}
  local threads=${counts[1]}
  local memory=${counts[2]}

  # Calculate total unread
  local total=$((mqtt + threads + memory))

  # Build status bar string
  local status=""

  # Only show channels with notifications
  if [ $mqtt -gt 0 ]; then
    status="$status$COLOUR_MQTT $mqtt"
  fi

  if [ $threads -gt 0 ]; then
    if [ -n "$status" ]; then
      status="$status $COLOUR_SEPARATOR "
    fi
    status="$status$COLOUR_THREADS $threads"
  fi

  if [ $memory -gt 0 ]; then
    if [ -n "$status" ]; then
      status="$status $COLOUR_SEPARATOR "
    fi
    status="$status$COLOUR_MEMORY $memory"
  fi

  # Update tmux status bar
  if [ -n "$status" ]; then
    tmux set-option -g status-right "🔔 $status" 2>/dev/null
  else
    tmux set-option -g status-right "" 2>/dev/null
  fi
}

# Check for changes and update
check_and_update() {
  local counts=($(get_notification_counts))
  local mqtt=${counts[0]}
  local threads=${counts[1]}
  local memory=${counts[2]}

  # Only update if something changed
  if [ $mqtt -ne $PREV_MQTT ] || \
     [ $threads -ne $PREV_THREADS ] || \
     [ $memory -ne $PREV_MEMORY ] || \
     [ $((mqtt + threads + memory)) -gt 0 ]; then

    update_status_bar

    # Update cache
    PREV_MQTT=$mqtt
    PREV_THREADS=$threads
    PREV_MEMORY=$memory
  fi
}

# Start monitoring in background
start_notification_monitor() {
  # Ensure tmux is running
  if ! command -v tmux &> /dev/null; then
    echo "❌ tmux not found. Cannot display notifications."
    return 1
  fi

  # Initial update
  update_status_bar

  echo "🔔 Notification bar started (updating every ${UPDATE_INTERVAL}s)"
  echo "   Press Ctrl+C to stop"

  # Monitor loop
  while true; do
    sleep $UPDATE_INTERVAL
    check_and_update
  done
}

# Auto-start if script is sourced (not executed)
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  # Script is being sourced
  start_notification_monitor &
  TMUX_NOTIFICATION_PID=$!

  # Cleanup on exit
  trap "kill $TMUX_NOTIFICATION_PID 2>/dev/null; tmux set-option -g status-right ''" EXIT

  echo "✅ Notification monitor running in background (PID: $TMUX_NOTIFICATION_PID)"
else
  # Script is being executed directly
  start_notification_monitor
fi
