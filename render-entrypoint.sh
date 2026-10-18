#!/bin/sh
set -eu

# This demo profile intentionally keeps Redis, the worker, and API in the
# same container so temporary upload/output paths are shared.
redis-server \
  --bind 127.0.0.1 \
  --protected-mode yes \
  --save "" \
  --appendonly no \
  --port 6379 \
  --dir /data/redis &
REDIS_PID=$!
WORKER_PID=""
API_PID=""

shutdown_children() {
  for child in "$API_PID" "$WORKER_PID" "$REDIS_PID"; do
    if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; fi
  done
  for child in "$API_PID" "$WORKER_PID" "$REDIS_PID"; do
    if [ -n "$child" ]; then wait "$child" 2>/dev/null || true; fi
  done
}
trap 'shutdown_children; exit 0' INT TERM

attempt=0
until redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; do
  if ! kill -0 "$REDIS_PID" 2>/dev/null; then
    echo "Redis exited before becoming ready" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Redis did not become ready within 30 seconds" >&2
    shutdown_children
    exit 1
  fi
  sleep 1
done

rq worker --url "${REDIS_URL:-redis://127.0.0.1:6379/0}" media-jobs &
WORKER_PID=$!
uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" &
API_PID=$!

# Keep the container alive while all three required processes are alive.
while kill -0 "$REDIS_PID" 2>/dev/null && \
      kill -0 "$WORKER_PID" 2>/dev/null && \
      kill -0 "$API_PID" 2>/dev/null; do
  sleep 2
done

STATUS=1
if ! kill -0 "$API_PID" 2>/dev/null; then
  wait "$API_PID" || STATUS=$?
elif ! kill -0 "$WORKER_PID" 2>/dev/null; then
  echo "RQ worker exited unexpectedly" >&2
elif ! kill -0 "$REDIS_PID" 2>/dev/null; then
  echo "Redis exited unexpectedly" >&2
fi
shutdown_children
exit "$STATUS"
