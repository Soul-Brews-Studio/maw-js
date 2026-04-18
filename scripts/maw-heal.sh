#!/usr/bin/env sh
# scripts/maw-heal.sh — auto-restore maw binary if bun sweeps it.
# Source from your shell init: `. /path/to/maw-heal.sh`
# Or run once on demand.
#
# Opt-out: export MAW_HEAL_DISABLED=1
# Silent:  export MAW_HEAL_SILENT=1

_maw_heal() {
  [ "${MAW_HEAL_DISABLED:-0}" = "1" ] && return 0

  # Fast path: maw is on PATH and the resolved target exists.
  if command -v maw >/dev/null 2>&1; then
    _maw_heal_path=$(command -v maw)
    if [ -x "$_maw_heal_path" ] && [ -e "$_maw_heal_path" ]; then
      # Follow one level of symlink; detect dangling link.
      _maw_heal_target=$(readlink "$_maw_heal_path" 2>/dev/null || true)
      if [ -z "$_maw_heal_target" ]; then
        unset _maw_heal_path _maw_heal_target
        return 0
      fi
      # Resolve relative symlink against the link's directory.
      case "$_maw_heal_target" in
        /*) _maw_heal_resolved="$_maw_heal_target" ;;
        *)  _maw_heal_resolved="$(dirname "$_maw_heal_path")/$_maw_heal_target" ;;
      esac
      if [ -e "$_maw_heal_resolved" ]; then
        unset _maw_heal_path _maw_heal_target _maw_heal_resolved
        return 0
      fi
      unset _maw_heal_resolved
    fi
    unset _maw_heal_path _maw_heal_target
  fi

  # Heal path: binary missing or dangling.
  if ! command -v bun >/dev/null 2>&1; then
    [ "${MAW_HEAL_SILENT:-0}" = "1" ] || echo "maw-heal: bun not on PATH — cannot auto-restore" >&2
    return 1
  fi

  [ "${MAW_HEAL_SILENT:-0}" = "1" ] || echo "maw-heal: restoring maw (was missing)…" >&2

  if bun add -g github:Soul-Brews-Studio/maw-js >/dev/null 2>&1; then
    [ "${MAW_HEAL_SILENT:-0}" = "1" ] || echo "maw-heal: restored maw (was missing)" >&2
    return 0
  else
    [ "${MAW_HEAL_SILENT:-0}" = "1" ] || echo "maw-heal: restore failed — run manually: bun add -g github:Soul-Brews-Studio/maw-js" >&2
    return 1
  fi
}

_maw_heal
