#!/bin/sh
# Starts the official a2aproject/a2a-samples helloworld agent, pinned to one
# commit, and waits until its agent card answers.
#
# The sample has no pyproject.toml and hard-codes port 9999 both in
# uvicorn.run and in the URL it publishes in its agent card, so a run on any
# other port is served from a copy of __main__.py with that port substituted.
# The pinned checkout itself is never modified.
#
# Environment:
#   HELLOWORLD_PORT   port to listen on, default 9999
#   A2A_SAMPLES_DIR   existing a2a-samples checkout to reuse instead of cloning
#   HELLOWORLD_PYTHON python version handed to uv, default 3.13
#
# Prints the base URL of the agent on stdout. Stop it with stop.sh.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

SAMPLES_REPO=https://github.com/a2aproject/a2a-samples.git
SAMPLES_COMMIT=6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3
SAMPLE_PATH=samples/python/agents/helloworld
# The port the sample hard-codes, and which the copy substitutes away from.
SAMPLE_PORT=9999

PORT=${HELLOWORLD_PORT:-${1:-9999}}
PYTHON_VERSION=${HELLOWORLD_PYTHON:-3.13}
CACHE_DIR="$REPO_ROOT/.cache"
CHECKOUT_DIR=${A2A_SAMPLES_DIR:-"$CACHE_DIR/a2a-samples"}
RUN_DIR="$CACHE_DIR/helloworld-$PORT"
PID_FILE="$CACHE_DIR/helloworld-$PORT.pid"
LOG_FILE="$CACHE_DIR/helloworld-$PORT.log"

command -v uv >/dev/null 2>&1 || {
  echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
}

mkdir -p "$CACHE_DIR"

# Clone once, pinned. A partial fetch of the exact commit is enough: the
# sample is read-only here and no history is needed.
if [ ! -d "$CHECKOUT_DIR/$SAMPLE_PATH" ]; then
  echo "cloning a2a-samples at $SAMPLES_COMMIT into $CHECKOUT_DIR" >&2
  rm -rf "$CHECKOUT_DIR"
  mkdir -p "$CHECKOUT_DIR"
  git -C "$CHECKOUT_DIR" init -q
  git -C "$CHECKOUT_DIR" remote add origin "$SAMPLES_REPO"
  git -C "$CHECKOUT_DIR" fetch -q --depth 1 origin "$SAMPLES_COMMIT"
  git -C "$CHECKOUT_DIR" checkout -q FETCH_HEAD
fi

SAMPLE_DIR="$CHECKOUT_DIR/$SAMPLE_PATH"
[ -f "$SAMPLE_DIR/__main__.py" ] || {
  echo "$SAMPLE_DIR does not hold the helloworld sample" >&2
  exit 1
}

# Refuse to start twice on the same port.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "helloworld is already running on port $PORT (pid $(cat "$PID_FILE"))" >&2
  exit 1
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"
cp "$SAMPLE_DIR/agent_executor.py" "$SAMPLE_DIR/requirements.txt" "$RUN_DIR/"
sed "s/$SAMPLE_PORT/$PORT/g" "$SAMPLE_DIR/__main__.py" > "$RUN_DIR/__main__.py"

echo "starting helloworld on 127.0.0.1:$PORT (python $PYTHON_VERSION, log $LOG_FILE)" >&2
(
  cd "$RUN_DIR"
  exec uv run \
    --quiet \
    --no-project \
    --python "$PYTHON_VERSION" \
    --with-requirements requirements.txt \
    python __main__.py
) >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

CARD_URL="http://127.0.0.1:$PORT/.well-known/agent-card.json"
DEADLINE=$(( $(date +%s) + 60 ))
while :; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "helloworld exited before serving its card; log follows:" >&2
    cat "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  if curl -sf -o /dev/null "$CARD_URL"; then
    break
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "helloworld did not serve $CARD_URL within 60 s; log follows:" >&2
    cat "$LOG_FILE" >&2
    kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 1
done

echo "helloworld is up on http://127.0.0.1:$PORT (pid $PID)" >&2
echo "http://127.0.0.1:$PORT"
