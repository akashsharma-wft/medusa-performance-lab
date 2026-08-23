# Running the lab in a Codespace

```bash
bash lab/bootstrap.sh                       # once: data tier + build + seed

# experiment 1 - what does ONE node do?
bash lab/start.sh 1
bash lab/run.sh cap-1node capacity.js PEAK_RATE=40 NODES=1

# experiment 2 - the scaling curve
bash lab/start.sh 2 && bash lab/run.sh cap-2node capacity.js PEAK_RATE=80  NODES=2
bash lab/start.sh 3 && bash lab/run.sh cap-3node capacity.js PEAK_RATE=120 NODES=3

# the same test against stock Medusa, for the defaults-vs-tuned comparison
bash lab/start.sh 1 default && bash lab/run.sh cap-default capacity.js PEAK_RATE=40 NODES=1

# experiment 3 - oversell stampede
bash lab/start.sh 3 && bash lab/run.sh oversell oversell-v2.js

# experiment 4 - break it on purpose
bash lab/start.sh 3
pkill -f "MEDUSA_WORKER_MODE=worker"        # kill the worker, watch q_wait climb
bash lab/run.sh queue-backlog capacity.js PEAK_RATE=60 NODES=3
```

Each run writes `results/cloud/<tag>/` containing the k6 output and summary, a
2-second CSV time series of Postgres / Redis / BullMQ, the post-run inventory
state, and the slowest queries by total execution time.

## Why the cores are pinned

The July results were measured with k6, PostgreSQL, Redis, four Node processes
and ten monitoring containers all competing for the same eight laptop cores, so
a "34 second p95" measured contention rather than Medusa. `lab/layout.sh` gives
each component a CPU budget nothing else can touch — `taskset` for processes,
`--cpuset-cpus` for containers — so the load generator physically cannot steal
cycles from the system under test.

## Why `capacity.js` replaces `steps.js`

`steps.js` is a **closed model**: 50 virtual users each start a new checkout
only once their previous one finished, so when the system slows down the load
politely slows down with it. It can measure latency but it can never find a
capacity ceiling.

`capacity.js` is an **open model**: N checkouts start every second regardless of
what the system is doing, which is how real traffic behaves. The arrival rate at
which p95 crosses the bar *is* the per-node capacity number, and that number is
what the scaling curve and the 100,000-user arithmetic are built from.
