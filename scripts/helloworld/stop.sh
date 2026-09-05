#!/bin/sh
# Stops the helloworld agent started by run.sh on the given port.
# Exits 0 when there was nothing to stop, so it is safe in an always() step.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

PORT=${HELLOWORLD_PORT:-${1:-9999}}
PID_FILE="$REPO_ROOT/.cache/helloworld-$PORT.pid"

[ -f "$PID_FILE" ] || { echo "no pid file for port $PORT, nothing to stop" >&2; exit 0; }

PID=$(cat "$PID_FILE")
rm -f "$PID_FILE"

kill -0 "$PID" 2>/dev/null || { echo "pid $PID is already gone" >&2; exit 0; }

kill "$PID" 2>/dev/null || true
# uv runs the interpreter as a child; give the group a moment, then insist.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
kill -9 "$PID" 2>/dev/null || true
echo "stopped helloworld on port $PORT (pid $PID)" >&2
