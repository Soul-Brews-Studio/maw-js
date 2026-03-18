#!/bin/bash
#
# WebSocket Integration Test Launcher
#
# Starts maw server and runs WebSocket tests

set -e

echo "🧪 WebSocket Integration Test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if maw server is running
if nc -z localhost 3456 2>/dev/null; then
    echo "✓ maw server already running on :3456"
    echo ""
    echo "Running tests..."
    bun run test-websocket.ts
    exit $?
fi

echo "Starting maw server..."
echo ""

# Start maw server in background
cd "$(dirname "$0")"
bun run dev &
SERVER_PID=$!

# Wait for server to start
echo "Waiting for server to be ready..."
for i in {1..30}; do
    if nc -z localhost 3456 2>/dev/null; then
        echo "✓ Server is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "✗ Server failed to start within 30 seconds"
        kill $SERVER_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

echo ""
echo "Running WebSocket tests..."
echo ""

# Run tests
bun run test-websocket.ts
TEST_EXIT_CODE=$?

# Cleanup
echo ""
echo "Stopping server..."
kill $SERVER_PID 2>/dev/null || true

# Wait for server to stop
wait $SERVER_PID 2>/dev/null || true

exit $TEST_EXIT_CODE
