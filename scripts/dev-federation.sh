#!/usr/bin/env bash
# dev-federation.sh — 2-node maw-js federation harness driver.
# Wraps `docker compose -f docker/compose.yml` with common dev actions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args]

Commands:
  up                    Build + start node-a and node-b (detached)
  down                  Stop containers and remove named volumes
  logs [a|b]            Tail logs from one service (default: both)
  shell [a|b]           Drop into container shell (default: a)
  probe [a|b]           Run 'maw peers probe peer' inside node-<a|b> (default: a)
  help                  Show this message

Host ports: node-a → :13456, node-b → :13457 (both serve 3456 internally).
EOF
}

resolve_service() {
  case "${1:-a}" in
    a|node-a) echo "node-a" ;;
    b|node-b) echo "node-b" ;;
    *) echo "unknown service: $1 (use a|b)" >&2; exit 2 ;;
  esac
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  up)
    "${COMPOSE[@]}" up -d --build
    ;;
  down)
    "${COMPOSE[@]}" down -v
    ;;
  logs)
    if [ $# -eq 0 ]; then
      "${COMPOSE[@]}" logs -f --tail=200
    else
      svc=$(resolve_service "$1")
      "${COMPOSE[@]}" logs -f --tail=200 "$svc"
    fi
    ;;
  shell)
    svc=$(resolve_service "${1:-a}")
    "${COMPOSE[@]}" exec "$svc" sh
    ;;
  probe)
    svc=$(resolve_service "${1:-a}")
    "${COMPOSE[@]}" exec "$svc" maw peers probe peer
    ;;
  help|-h|--help|"")
    usage
    ;;
  *)
    echo "unknown command: $cmd" >&2
    usage
    exit 2
    ;;
esac
