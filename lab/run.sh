#!/usr/bin/env bash
# One experiment: start the sampler, run k6, stop the sampler, file everything
# under results/cloud/<tag>/ so every number in the blog traces to a run.
#   bash lab/run.sh cap-1node capacity.js PEAK_RATE=40 NODES=1
set -euo pipefail
cd "$(dirname "$0")/.."
source lab/layout.sh

TAG="${1:?usage: run.sh <tag> <script.js> [KEY=VAL ...]}"
SCRIPT="${2:?}"; shift 2

OUT="results/cloud/$TAG"; mkdir -p "$OUT"
[ -f lab/run/url ] || { echo "nothing running - use lab/start.sh first"; exit 1; }
source lab/run/url
source k6/.env.k6 2>/dev/null || true

echo "=== $TAG ==="
layout_print
echo "url: $MEDUSA_URL"

# Reset the cumulative PG counters so rollbacks/deadlocks in this run are
# attributable to this run and not to everything since the container booted.
docker exec mpl-postgres psql -U medusa -d medusa_perf -qc \
  "SELECT pg_stat_statements_reset(); SELECT pg_stat_reset();" >/dev/null 2>&1 || true

bash lab/sample.sh "$OUT/samples.csv" & SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT

EXTRA_ARGS=()
for kv in "$@"; do EXTRA_ARGS+=(-e "$kv"); done

taskset -c "$K6_CPUS" k6 run \
  -e MEDUSA_URL="$MEDUSA_URL" \
  -e MEDUSA_PUBLISHABLE_KEY="${MEDUSA_PUBLISHABLE_KEY:-}" \
  -e MEDUSA_REGION_ID="${MEDUSA_REGION_ID:-}" \
  -e MEDUSA_SALES_CHANNEL_ID="${MEDUSA_SALES_CHANNEL_ID:-}" \
  -e LOW_STOCK_VARIANT_ID="${LOW_STOCK_VARIANT_ID:-}" \
  "${EXTRA_ARGS[@]}" \
  --summary-export "$OUT/summary.json" \
  "k6/$SCRIPT" 2>&1 | tee "$OUT/output.txt"

kill $SAMPLER 2>/dev/null || true

# Inventory truth, straight from the database - this is the oversell check
docker exec mpl-postgres psql -U medusa -d medusa_perf -c "
  SELECT il.stocked_quantity, il.reserved_quantity, ii.sku
  FROM inventory_level il JOIN inventory_item ii ON ii.id = il.inventory_item_id
  WHERE ii.sku LIKE 'OVERSELL%';" > "$OUT/inventory-after.txt" 2>/dev/null || true

docker exec mpl-postgres psql -U medusa -d medusa_perf -c "
  SELECT calls, round(mean_exec_time::numeric,2) AS avg_ms,
         round(total_exec_time::numeric,0) AS total_ms, left(query,90) AS query
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;" > "$OUT/slow-queries.txt" 2>/dev/null || true

echo
echo "saved -> $OUT/{output.txt,summary.json,samples.csv,inventory-after.txt,slow-queries.txt}"
