# Medusa v2 Black Friday performance lab

Reproduces the numbers behind ["Medusa Under Black Friday Load"](https://akash-wft-blog.pages.dev/posts/medusa-checkout-performance-black-friday.html):
scaling a Medusa v2 store from 1 to 5 instances, an 80-buyer stampede over 5
units of stock, and where the bottleneck actually sits.

Everything runs in Docker. Nothing here requires a specific OS — Docker
Desktop on Windows, Mac, or Linux with the `docker compose` plugin is enough.

## What's actually being measured

Every service — Postgres, Redis, each Medusa instance, the load balancer, the
k6 load generator — is pinned to its own CPU cores via `cpuset`, and no two
services share a core. That isolation is the entire point: without it, the
load generator and the database compete for the same cycles and you measure
the contention, not the software. See `docker-compose.yml` for the layout.

## Requirements

- Docker Desktop (or Docker Engine + the `compose` plugin)
- A machine with at least 8 logical cores. 16 is what the published numbers
  used; adjust the `*_CPUS` values in `.env` to whatever you have — just keep
  every range non-overlapping.

## 1. Set up

```bash
cp .env.example .env        # adjust core counts if your machine isn't 16-thread
docker compose build         # builds the Medusa image from lab/Dockerfile.medusa
docker compose up -d postgres redis
```

Wait for both to report healthy: `docker compose ps`.

## 2. Seed the catalog

```bash
docker compose run --rm app1 sh -c \
  "cd /app/apps/backend && npx medusa db:migrate && npx medusa exec ./src/scripts/seed-load-test-data.ts"
```

This creates 205 products, one of them (`OVERSELL-TEST-1`) held at exactly 5
units for the stampede test.

## 3. Start the app tier

**Single instance** (baseline, reachable at `localhost:9000`):
```bash
docker compose up -d app1
```

**Full 5-instance fleet** (behind the balancer at `localhost:9020`):
```bash
docker compose --profile cluster up -d
```

Wait for health: `curl http://localhost:9000/health` (single) or
`curl http://localhost:9020/health` (fleet).

## 4. Get your own k6 environment

The IDs a fresh install creates (region, sales channel, publishable key,
low-stock variant) are **not** the ones in this repo's example file — copy
them from your own database:

```bash
docker compose run --rm app1 sh -c \
  "cd /app/apps/backend && npx medusa exec ./src/scripts/print-test-env.ts"
```

Paste the printed block into `k6/.env.k6` (copy `k6/.env.k6.example` first).

## 5. Run the tests

```bash
set -a; source k6/.env.k6; set +a   # or: Get-Content k6/.env.k6 | ... on Windows

# Scaling curve: run once per fleet size, changing VUS to 10x the instance count.
docker compose run --rm k6 run -e MEDUSA_URL=http://app1:9000 \
  -e VUS=10 -e DURATION=4m /scripts/scale.js

docker compose run --rm k6 run -e MEDUSA_URL=http://lb:9020 \
  -e VUS=50 -e DURATION=4m /scripts/scale.js     # 5-instance fleet, 10 VUs/instance

# Oversell stampede: 40 buyers, 80 attempts, 5 units. Run against the fleet.
docker compose run --rm k6 run -e MEDUSA_URL=http://lb:9020 /scripts/oversell-v2.js
```

`k6/scale.js` is a **closed-model** test (fixed concurrent users) — it's the
one the scaling curve is built from. It can't collapse into "everything timed
out," which is what an open/arrival-rate model does once you're over a single
instance's capacity (roughly 0.1–0.2 checkouts/sec on 2 cores). See the
comment at the top of the file if you want the full reasoning.

Between runs, reset the oversell SKU back to 5 available units:
```bash
docker compose run --rm app1 sh -c \
  "cd /app/apps/backend && npx medusa exec ./src/scripts/reset-oversell.ts"
```
Editing `inventory_level` directly with SQL does **not** work — Medusa
computes availability through its inventory module, not by reading that
column, so a raw UPDATE leaves it reporting `insufficient_inventory` even
when the table looks correct. This script goes through Medusa's own module
services instead.

## 6. Read the results

k6 prints a summary to the terminal. For the consolidated table used in the
blog (`lab/analyze.py` reads every `results/cloud/<tag>/summary.json`):

```bash
docker compose run --rm k6 run --summary-export /results/<tag>/summary.json ...
python3 lab/analyze.py
```

## Notes on what changed between the default and "optimized" configuration

`medusa-config.ts` reads `DISABLE_OPTIMIZATIONS`:
- `false` (the compose default) — Redis-backed event bus, cache, workflow
  engine, and locking; pool of 40 connections per instance.
- `true` — Medusa's out-of-the-box defaults: in-memory event bus, workflow
  engine, cache, and locking, small connection pool. Set this on `app1` in
  `docker-compose.yml` to reproduce the "stock Medusa" comparison.

## Caveats carried over from the original test

- Everything ran on one physical machine; five instances plus Postgres,
  Redis, k6 and the balancer share 16 threads. Absolute throughput numbers
  belong to that machine — the *ratios* between fleet sizes are what transfer.
- The database was never scaled alongside the app tier on purpose, to show
  where the bottleneck moves. If you're trying to beat the published numbers,
  give Postgres more cores and put a pooler (PgBouncer) in front of it first.
- Payment uses Medusa's test provider (`pp_system_default`), which performs
  no network I/O. A real gateway adds latency this lab doesn't measure.
