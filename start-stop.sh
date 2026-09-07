#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT="$SCRIPT_DIR"
PID_FILE="${QQ_AUTH_PID_FILE:-$PROJECT_ROOT/qq-miniapp-auth.pid}"
LOG_FILE="${QQ_AUTH_LOG_FILE:-$PROJECT_ROOT/logs/qq-miniapp-auth.log}"
NODE_BIN="${NODE_BIN:-node}"
ENTRY_FILE="$PROJECT_ROOT/start-all.js"

usage() {
  cat <<'EOF'
Usage: ./start-stop.sh {start|stop|restart|status|logs}

Commands:
  start    Start Web service and bridge in the background.
  stop     Stop the background service.
  restart  Stop and then start the service.
  status   Show whether the background service is running.
  logs     Follow the service log (Ctrl+C to exit).
EOF
}

read_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "$pid"
}

is_running() {
  local pid
  pid=$(read_pid) || return 1
  kill -0 "$pid" 2>/dev/null
}

start_service() {
  if is_running; then
    local pid
    pid=$(read_pid)
    echo "Already running (PID $pid)."
    return 0
  fi

  if [[ -f "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
  fi

  if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "Error: Node.js executable not found: $NODE_BIN" >&2
    exit 1
  fi

  if [[ ! -f "$ENTRY_FILE" ]]; then
    echo "Error: entry file not found: $ENTRY_FILE" >&2
    exit 1
  fi

  mkdir -p "$(dirname -- "$LOG_FILE")" "$(dirname -- "$PID_FILE")"

  nohup "$NODE_BIN" "$ENTRY_FILE" >>"$LOG_FILE" 2>&1 </dev/null &
  local pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"

  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Error: service exited immediately. Recent log output:" >&2
    tail -n 50 "$LOG_FILE" >&2 || true
    exit 1
  fi

  echo "Started (PID $pid)."
  echo "Log: $LOG_FILE"
}

stop_service() {
  local pid
  if ! pid=$(read_pid); then
    if [[ -f "$PID_FILE" ]]; then
      rm -f "$PID_FILE"
    fi
    echo "Not running."
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Not running (removed stale PID file)."
    return 0
  fi

  echo "Stopping (PID $pid)..."
  kill -TERM "$pid" 2>/dev/null || true

  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < 15 )); do
    sleep 1
    waited=$((waited + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "Service did not stop gracefully, sending SIGKILL..."
    kill -KILL "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo "Stopped."
}

status_service() {
  if is_running; then
    local pid
    pid=$(read_pid)
    echo "Running (PID $pid)."
    return 0
  fi

  if [[ -f "$PID_FILE" ]]; then
    echo "Not running (stale PID file)."
    return 1
  fi

  echo "Not running."
  return 1
}

case "${1:-}" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    status_service
    ;;
  logs)
    if [[ ! -f "$LOG_FILE" ]]; then
      echo "Log file does not exist: $LOG_FILE" >&2
      exit 1
    fi
    tail -n 200 -F "$LOG_FILE"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
