#!/usr/bin/env bash
# Copies what the viewer shares with the live mod into the viewer's own folder: source files, shared types and options.
# The plugin loader accepts no import from outside a plugin's folder, and an installed plugin is a copy of that folder alone.
# `--check` changes nothing and fails when a copy is out of date.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-copy}

emit_source() {
  echo "// Copy of hooks/$1.ts. Edit that file, then run scripts/sync-viewer.sh."
  cat "$root/hooks/$1.ts"
}

# The viewer's state contract must be one file with no import, so it is the shared types followed by the viewer's own.
emit_types() {
  echo "// The shared types are a copy of types/index.d.ts, the rest is viewer/types/contract.tail. Edit those, then run scripts/sync-viewer.sh."
  sed '/^declare module/,$d' "$root/types/index.d.ts"
  cat "$root/viewer/types/contract.tail"
}

# The viewer's manifest with the live mod's options. Two of them have no meaning there: a transcript holds neither the record
# numbers that a hook adds nor the refusal of a hook.
emit_manifest() {
  jq --argjson options "$(jq .userConfig "$root/.claude-plugin/plugin.json")" '.userConfig = ($options | del(.hookRecords, .hookReasons))' "$root/viewer/.claude-plugin/plugin.json"
}

stale=0
write() {
  local target=$1 content
  content=$(cat)
  if [ "$mode" = "--check" ]; then
    if [ "$(cat "$target" 2>/dev/null)" != "$content" ]; then
      echo "out of date: ${target#"$root"/}" >&2
      stale=1
    fi
  else
    printf '%s\n' "$content" >"$target"
  fi
}

for name in map text board pane; do
  emit_source "$name" | write "$root/viewer/hooks/$name.ts"
done
emit_types | write "$root/viewer/types/index.d.ts"
emit_manifest | write "$root/viewer/.claude-plugin/plugin.json"

exit "$stale"
