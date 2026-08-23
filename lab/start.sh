#!/usr/bin/env bash
# Start N Medusa API instances (+1 worker when N>1), each pinned to its own
# core, behind the round-robin load balancer on :9020.
#   bash lab/start.sh 2            # 2 API instances + 1 worker, optimized
#   bash lab/start.sh 1 default    # 1 instance, stock Medusa defaults
#   bash lab/start.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
source lab/layout.sh

SERVER_DIR="medusa-backend/apps/backend/.medusa/server"
mkdir -p lab/run lab/logs

stop_all () {
  [ -f lab/run/pids ] && while read -r p; do kill "$p" 2>/dev/null || true; done < lab/run/pids
  rm -f lab/run/pids
  pkill -f "lb.js" 2>/dev/null || true
  echo "stopped."
}

[ "${1:-}" = "stop" ] && { stop_all; exit 0; }

N="${1:-1}"
MODE="${2:-optimized}"          # optimized | default
stop_all >/dev/null 2>&1 || true
: > lab/run/pids

if [ "$MODE" = "default" ]; then
  # Stock Medusa: in-memory event bus, workflow engine, cache and locking,
  # default pool. This is what `medusa start` gives you with no config.
  EXTRA="DISABLE_OPTIMIZATIONS=true"
  echo "==> DEFAULT config (in-memory modules, no Redis)"
else
  EXTRA="DISABLE_OPTIMIZATIONS=false"
  echo "==> OPTIMIZED config (Redis modules, pool 40)"
fi

PORTS=()
for i in $(seq 1 "$N"); do
  PORT=$((9000 + i - 1)); PORTS+=("$PORT")
  CPU=$(app_cpu_for "$i")
  env $EXTRA MEDUSA_WORKER_MODE=$([ "$N" -gt 1 ] && echo server || echo shared) \
      PORT="$PORT" NODE_ENV=production \
    taskset -c "$CPU" node "$SERVER_DIR/node_modules/.bin/medusa" start \
    > "lab/logs/app$i.log" 2>&1 &
  echo $! >> lab/run/pids
  echo "   app$i  port $PORT  core $CPU"
done

if [ "$N" -gt 1 ]; then
  CPU=$(app_cpu_for $((N + 1)))
  env $EXTRA MEDUSA_WORKER_MODE=worker NODE_ENV=production \
    taskset -c "$CPU" node "$SERVER_DIR/node_modules/.bin/medusa" start \
    > lab/logs/worker.log 2>&1 &
  echo $! >> lab/run/pids
  echo "   worker      core $CPU"
fi

# LB only when there is something to balance
if [ "$N" -gt 1 ]; then
  TARGETS="$(IFS=,; echo "${PORTS[*]}")" node lab/lb.js > lab/logs/lb.log 2>&1 &
  echo $! >> lab/run/pids
  echo "   lb    port 9020 -> $(IFS=,; echo "${PORTS[*]}")"
  echo "MEDUSA_URL=http://localhost:9020" > lab/run/url
else
  echo "MEDUSA_URL=http://localhost:9000" > lab/run/url
fi

printf "==> waiting for health"
URL=$(cut -d= -f2 lab/run/url)
for _ in $(seq 1 90); do
  curl -sf "$URL/health" >/dev/null 2>&1 && { echo " ready"; exit 0; }
  printf "."; sleep 2
done
echo " TIMEOUT - check lab/logs/"; exit 1
