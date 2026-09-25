#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-}"
if [ "$#" -gt 1 ]; then
  printf 'Usage: npm run dev:live [-- /path/to/repository]\n' >&2
  exit 1
fi
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -n "$repo_root" ]; then
  repo_root="$(cd "$repo_root" && pwd)"
fi

watcher_workspace_root="$repo_root"
if [ -z "$watcher_workspace_root" ]; then
  watcher_workspace_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
fi

if ! command -v clojure >/dev/null 2>&1; then
  printf 'Clojure CLI is required for Live Activity.\n' >&2
  exit 1
fi

viewer_port="${CODEWALK_VIEWER_PORT:-4173}"
export CODEWALK_VIEWER_PORT="$viewer_port"

runtime_dir="${CODEWALK_RUNTIME_DIR:-${HOME}/.codewalk/runtime}"
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
api_log="${runtime_dir}/api.log"
watcher_log="${runtime_dir}/session-watcher.log"
activity_dir="${CODEWALK_ACTIVITY_DIR:-${HOME}/.codewalk/activity}"
activity_token_file="${CODEWALK_ACTIVITY_TOKEN_FILE:-${activity_dir}/token}"
mkdir -p "$activity_dir"
chmod 700 "$activity_dir"
if [ -z "${CODEWALK_ACTIVITY_TOKEN:-}" ]; then
  if [ -s "$activity_token_file" ]; then
    CODEWALK_ACTIVITY_TOKEN="$(tr -d '\r\n' <"$activity_token_file")"
  else
    umask 077
    CODEWALK_ACTIVITY_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    printf '%s\n' "$CODEWALK_ACTIVITY_TOKEN" >"$activity_token_file"
    chmod 600 "$activity_token_file"
  fi
fi
export CODEWALK_ACTIVITY_TOKEN
export CODEWALK_ACTIVITY_TOKEN_FILE="$activity_token_file"
export CODEWALK_INGEST_URL="${CODEWALK_INGEST_URL:-http://127.0.0.1:4180/api/activity/events}"
export CODEWALK_ACTIVITY_ORIGINS="${CODEWALK_ACTIVITY_ORIGINS:-http://127.0.0.1:${viewer_port},http://localhost:${viewer_port}}"
if [ -n "$repo_root" ]; then
  clojure -M:run serve --repo-root "$repo_root" >"$api_log" 2>&1 &
else
  clojure -M:run serve >"$api_log" 2>&1 &
fi
api_pid=$!
viewer_pid=""
watcher_pid=""

terminate-and-wait() {
  local pid="$1"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  if [ -n "$pid" ]; then
    wait "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  terminate-and-wait "$viewer_pid"
  terminate-and-wait "$watcher_pid"
  terminate-and-wait "$api_pid"
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

attempt=0
until curl -fsS http://127.0.0.1:4180/api/health >/dev/null 2>&1; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    printf 'The Codewalk API stopped during startup. Log: %s\n' "$api_log" >&2
    cat "$api_log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    printf 'Timed out waiting for the Codewalk API. Log: %s\n' "$api_log" >&2
    exit 1
  fi
  sleep 0.2
done

CODEWALK_TAILER_MODE=session-state \
CODEWALK_WORKSPACE_ROOT="$watcher_workspace_root" \
CODEWALK_SESSION_ALL_WORKSPACES=true \
CODEWALK_SESSION_STATE_DIR="${COPILOT_SESSION_STATE_DIR:-${COPILOT_HOME:-${HOME}/.copilot}/session-state}" \
node "$script_dir/../producer/bin/tailer.mjs" >"$watcher_log" 2>&1 &
watcher_pid=$!

if ! kill -0 "$watcher_pid" 2>/dev/null; then
  printf 'The Codewalk session watcher stopped during startup. Log: %s\n' "$watcher_log" >&2
  cat "$watcher_log" >&2
  exit 1
fi

if [ -n "$repo_root" ]; then
  printf 'Codewalk API is running with %s as the default repository.\n' "$repo_root"
else
  printf 'Codewalk API is running without a preselected repository; observing all workspaces.\n'
fi
printf 'API log: %s\n' "$api_log"
printf 'Session watcher log: %s\n' "$watcher_log"
viewer_bin="$(CDPATH= cd -- "$script_dir/.." && pwd)/node_modules/.bin/vite"
if [ ! -x "$viewer_bin" ]; then
  printf 'The Codewalk Vite executable was not found: %s\n' "$viewer_bin" >&2
  exit 1
fi
(
  cd "$script_dir/.."
  exec "$viewer_bin"
) &
viewer_pid=$!
wait "$viewer_pid"
viewer_status=$?
viewer_pid=""
exit "$viewer_status"
