# Measured numbers — consolidated for the blog (sessions of 2026-07-14 and 2026-07-15)

All tests: k6 driving the full Store-API checkout flow (browse → cart → item →
addresses → shipping → payment collection → payment session → complete) on one
AMD Ryzen 7 5800HS laptop (8c/16t, 16GB), Medusa v2.17.2 production build,
Node 22, PG 16 (Docker, port 5433), Redis 7 (Docker). Load generator shares the host.

## Same-day pair (2026-07-15): 50 VUs, 3-minute profile, identical script (steps.js)

| Metric | Default config (1 proc, in-memory modules) | Optimized (LB → 3 API + 1 worker, Redis modules, pool 40×3) |
|---|---|---|
| Completed checkouts | **1** (0.005/s) | **285** (1.54/s sustained) — **285x** |
| Request failure rate | 6.27% (18 of 287) | 0.15% (4 of 2,582) |
| p95 request duration | 60s (timeout wall) | 11.8s |

Default config per-step p95 (same run): browse 17.5s · create cart 27.0s ·
add item 44.2s · addresses 34.5s · **shipping 60s (timeout)** · payment
collection 13.9s · payment session 9.16s · complete 41.7s (1 sample).
Optimized payment session p95 2.11s vs default 9.16s. The default config's
requests queue so deep that the shipping-options step alone exhausts the
60-second timeout — checkouts die mid-flow, which is why only 1 completed.

## Per-step latency at 50 VUs, optimized topology (2026-07-15, steps.js)

| Step | avg | med | p95 |
|---|---|---|---|
| browse (list products) | 1.16s | 678ms | 3.25s |
| create cart | 2.13s | 1.35s | 5.72s |
| add line item | 3.06s | 2.11s | 7.94s |
| set addresses | 2.65s | 1.87s | 7.09s |
| shipping options+method | 5.74s | 3.94s | 13.97s |
| payment collection | 1.04s | 674ms | 3.02s |
| payment session (pp_system_default) | 732ms | 472ms | 2.11s |
| complete (order+inventory+workflow) | 9.02s | 6.48s | 19.69s |

Payment steps are the two cheapest write steps (test provider = no external
gateway latency); `complete` — order creation, inventory commit, workflow — is
the most expensive step, ~4.5x the payment session p95.

## Oversell / inventory locking (2026-07-15, oversell-v2.js)

- 40 concurrent buyers, 80 checkout attempts, all targeting ONE variant with 5 units
- Entire race resolved in 35s
- Result: exactly 5 completed orders, 75 rejected, 0 interrupted
- DB verification after: stocked_quantity=5, reserved_quantity=5, orders_for_sku=5,
  stock never negative. PG `locks_waiting=0` in every sample; rejected attempts
  visible as transaction rollbacks (xact_rollback climbing during run), 0 deadlocks.

## Queue management (live sampler during runs, 2026-07-15)

- Medusa's Redis event bus + workflow engine run on BullMQ queues:
  `bull:medusa-workflows`, `bull:medusa-workflows-jobs`, `bull:workflows-cleaner`
- Queue depth during 40-VU oversell stampede: wait=0, active=0 in every 5s sample —
  the dedicated worker process drained jobs as fast as the API produced them
- Interpretation: at laptop scale the queue never backs up; the metric to alarm on
  in production is `wait` depth growing monotonically.

## Redis performance

- 2026-07-15 50-VU optimized run (15m window incl. run):
  peak 347 ops/sec, avg command latency 16.6µs, keyspace hit rate 58.4%, 36 clients
- Oversell stampede: peak 946 ops/sec (sampler, instantaneous_ops_per_sec)
- 2026-07-14 final suite window (18:00–18:25 IST): peak 39 ops/sec (1m rate),
  avg cmd latency 489µs (includes saturation phases), hit rate 36.5%
- 2026-07-14 baseline window: Redis at ~1.6 ops/sec, 1 client (exporter only) —
  measured proof the default config never touches Redis
- Context: a single Redis instance is typically benchmarked at 100k+ ops/sec —
  the lab peaked below 1k. Redis ran at <1% capacity: NOT a bottleneck at any tier tested.

## PostgreSQL bottlenecks

- Backends: 12 (baseline day-1) → 42 (single-instance pool 40) → 82 (day-1 fleet)
  → 110 peak (day-2 fleet + baseline instance) — vs default max_connections=100
  (raised to 300 after "FATAL: too many clients already" with 3×pool40=120 demand)
- Commits/sec peak: ~84/s (day-1 baseline collapse) → ~590/s (day-2 optimized 50-VU run)
- pg_stat_statements (day-1): hottest query avg 2.3ms — no slow queries; cost is
  many small queries per checkout, not bad queries
- Postgres CPU: ~50% during day-1 baseline collapse (Node was at 150% = the real
  bottleneck); 220% after single-instance optimization (bottleneck relocated)
- Deadlocks: 0 in every window measured, both days

## Stress ceiling / "hundreds of thousands of checkouts" (2026-07-14, stress.js)

- ramping-arrival-rate to 2,000 checkout-attempts/sec, maxVUs 3,000, 8 minutes
- 202,676 checkout attempts executed + 166,923 dropped (couldn't be scheduled) =
  ~370k attempts demanded in 8 minutes
- At that arrival rate on one host: ~100% failure — far beyond one machine's capacity,
  by design. The number that matters is the per-unit capacity below.

## Day-1 vs day-2 variance note

Day-1 optimized 50-VU run completed 36 checkouts; day-2 identical topology
completed 285. Day-1 suite ran after ~6h of continuous load testing on a
thermally saturated laptop, and after the 300-VU and browse-10k runs against the
same processes. Same-day pairs are the only honest comparisons; both are reported
with dates. (Day-1 default-config baseline: 2 completed checkouts, p95 57.4s,
health endpoint 103s. Day-2 same-day pair: see table above.)

## Extrapolation arithmetic (the part that scales)

Unit measured (day-2): one laptop-hosted instance-set (LB → 3 API + 1 worker,
shared with PG+Redis+monitoring+k6) sustains ~1.5 completed checkouts/sec at
50 concurrent users with 0.15% errors.

Formula: instance-sets needed ≈ (forecast concurrent checkouts × per-checkout
service demand) / per-set capacity. Worked example for "100,000 concurrent users":
- Assume 5–10% are in active checkout → 5,000–10,000 concurrent checkouts
- If a production-grade instance-set (dedicated cores, no co-hosted load generator/
  DB/monitoring) sustains 50–100 concurrent checkouts at acceptable p95 —
  a conservative 10–20x our shared-laptop unit —
  → ≈ 50–200 instance-sets behind a load-balancer tier
- DB tier must be sized for (sets × instances × pool): e.g. 100 sets × 3 × 40 =
  12,000 wanted connections → PgBouncer mandatory (Postgres default max: 100)
- One shared Redis cluster (locks/events/workflows MUST be globally visible —
  per-set Redis would break oversell protection); lab peak <1k ops/sec/set means
  even 100 sets ≈ 100k ops/sec ≈ one beefy Redis instance's capacity; cluster for headroom
- Autoscaling signal: p95 latency + event-queue `wait` depth + Node CPU (the lab's
  bottleneck order), NOT database CPU
