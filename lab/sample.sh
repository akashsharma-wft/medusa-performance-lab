#!/usr/bin/env bash
# Samples the stateful tier every 2s into a CSV. This is what the eight
# ticket-topic charts are drawn from - real time series, not screenshots.
#   bash lab/sample.sh results/cloud/run1-samples.csv
set -uo pipefail
OUT="${1:?usage: sample.sh <out.csv>}"
INTERVAL="${INTERVAL:-2}"
mkdir -p "$(dirname "$OUT")"

PSQL="docker exec mpl-postgres psql -U medusa -d medusa_perf -tAc"
RCLI="docker exec mpl-redis redis-cli"

echo "t,pg_conns,pg_active,pg_idle_in_txn,pg_commits,pg_rollbacks,pg_deadlocks,pg_locks_waiting,pg_pct_cpu,redis_ops,redis_clients,redis_hits,redis_misses,redis_used_mb,q_wait,q_active,q_completed,q_failed" > "$OUT"

t0=$(date +%s)
while true; do
  now=$(( $(date +%s) - t0 ))

  read -r conns active idle_txn <<<"$($PSQL "SELECT count(*), count(*) FILTER (WHERE state='active'), count(*) FILTER (WHERE state='idle in transaction') FROM pg_stat_activity" 2>/dev/null | tr '|' ' ')"
  read -r commits rollbacks deadlocks <<<"$($PSQL "SELECT xact_commit, xact_rollback, deadlocks FROM pg_stat_database WHERE datname='medusa_perf'" 2>/dev/null | tr '|' ' ')"
  locks=$($PSQL "SELECT count(*) FROM pg_locks WHERE NOT granted" 2>/dev/null)
  pgcpu=$(docker stats --no-stream --format '{{.CPUPerc}}' mpl-postgres 2>/dev/null | tr -d '%')

  info=$($RCLI info 2>/dev/null | tr -d '\r')
  gv () { echo "$info" | grep -m1 "^$1:" | cut -d: -f2; }
  rops=$(gv instantaneous_ops_per_sec); rcli=$(gv connected_clients)
  rhit=$(gv keyspace_hits); rmiss=$(gv keyspace_misses)
  rmem=$(echo "$info" | grep -m1 '^used_memory:' | cut -d: -f2)
  rmem=$(awk -v b="${rmem:-0}" 'BEGIN{printf "%.1f", b/1048576}')

  # BullMQ queue depth: `wait` growing monotonically is the real alarm signal.
  qw=0; qa=0; qc=0; qf=0
  for q in bull:medusa-workflows bull:medusa-workflows-jobs; do
    qw=$(( qw + $($RCLI llen "$q:wait"   2>/dev/null || echo 0) ))
    qa=$(( qa + $($RCLI llen "$q:active" 2>/dev/null || echo 0) ))
    qc=$(( qc + $($RCLI zcard "$q:completed" 2>/dev/null || echo 0) ))
    qf=$(( qf + $($RCLI zcard "$q:failed"    2>/dev/null || echo 0) ))
  done

  echo "$now,${conns:-},${active:-},${idle_txn:-},${commits:-},${rollbacks:-},${deadlocks:-},${locks:-},${pgcpu:-},${rops:-},${rcli:-},${rhit:-},${rmiss:-},${rmem:-},$qw,$qa,$qc,$qf" >> "$OUT"
  sleep "$INTERVAL"
done
