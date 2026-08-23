# Live sampler for the performance lab: every ~5s dump Redis performance,
# BullMQ queue depths, and Postgres connection/commit stats.
# Usage: powershell -File sample-live.ps1 -Seconds 240 -OutFile results\final4\live-samples.txt
param(
  [int]$Seconds = 240,
  [string]$OutFile = "results\final4\live-samples.txt"
)

$deadline = (Get-Date).AddSeconds($Seconds)
$n = 0
while ((Get-Date) -lt $deadline) {
  $n++
  $ts = Get-Date -Format "HH:mm:ss"
  Add-Content $OutFile "=== sample $n ($ts) ==="

  # Redis: throughput, latency-relevant counters, memory, clients
  $info = docker exec mpl-redis redis-cli INFO 2>$null
  $keep = $info | Select-String -Pattern "^(instantaneous_ops_per_sec|total_commands_processed|keyspace_hits|keyspace_misses|used_memory_human|connected_clients|blocked_clients|total_net_input_bytes):"
  Add-Content $OutFile ("[redis] " + (($keep | ForEach-Object { $_.Line.Trim() }) -join " | "))

  # BullMQ queues: wait/active/delayed depths for every bull:* queue
  $queues = docker exec mpl-redis redis-cli --scan --pattern "bull:*:meta" 2>$null
  foreach ($q in $queues) {
    $base = $q -replace ":meta$", ""
    $wait = docker exec mpl-redis redis-cli LLEN "${base}:wait" 2>$null
    $active = docker exec mpl-redis redis-cli LLEN "${base}:active" 2>$null
    $delayed = docker exec mpl-redis redis-cli ZCARD "${base}:delayed" 2>$null
    $completed = docker exec mpl-redis redis-cli ZCARD "${base}:completed" 2>$null
    $failed = docker exec mpl-redis redis-cli ZCARD "${base}:failed" 2>$null
    Add-Content $OutFile "[queue] $base wait=$wait active=$active delayed=$delayed completed=$completed failed=$failed"
  }

  # Postgres: connections by state, commits, locks not granted
  $pg = docker exec mpl-postgres psql -U medusa -d medusa_perf -t -A -c "SELECT 'conns_total=' || count(*) || ' active=' || count(*) FILTER (WHERE state='active') || ' idle=' || count(*) FILTER (WHERE state='idle') FROM pg_stat_activity WHERE datname='medusa_perf'; SELECT 'xact_commit=' || xact_commit || ' rollbacks=' || xact_rollback FROM pg_stat_database WHERE datname='medusa_perf'; SELECT 'locks_waiting=' || count(*) FROM pg_locks WHERE NOT granted;" 2>$null
  Add-Content $OutFile ("[pg] " + (($pg | Where-Object { $_ }) -join " | "))

  Add-Content $OutFile ""
  Start-Sleep -Seconds 5
}
Add-Content $OutFile "=== sampler done ($n samples) ==="
