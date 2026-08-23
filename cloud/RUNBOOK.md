# Cloud rig runbook

Every machine has exactly one job. That is the whole point: in the laptop lab
the load generator, the database, the cache, four Node processes and ten
monitoring containers shared eight cores, so a "34 second p95" measured the
laptop rather than Medusa.

```
loadgen ──▶ app1 … appN ──▶ db  (Postgres + PgBouncer + Redis)
  k6            Medusa
```

## 0 — before anything

- Redeem **Azure for Students** (`azure.microsoft.com/free/students`) — $100, no card.
- Check **Total Regional vCPUs** quota for your region. Each VM is 2 vCPU, so
  a 4-node curve needs 12. If the quota is lower, run the curve to 2 or 3 nodes,
  or `add-app` / `stop` between phases to stay under it.
- Push this repo to GitHub; the setup scripts clone it onto each VM.
- `az login`

## 1 — provision

```bash
bash cloud/provision.sh create 2     # loadgen + db + app1 + app2
bash cloud/provision.sh ips
```

## 2 — install

```bash
# db first: the app nodes need it up before they boot
ssh azureuser@<db-public>       'sudo bash -s' < cloud/setup-db.sh

# each app node
ssh azureuser@<app1-public> "sudo REPO_URL=<repo> DB_HOST=<db-private> \
    WORKER_MODE=server bash -s" < cloud/setup-app.sh

# one node runs as the worker tier instead of serving traffic
ssh azureuser@<appN-public> "sudo REPO_URL=<repo> DB_HOST=<db-private> \
    WORKER_MODE=worker bash -s" < cloud/setup-app.sh

ssh azureuser@<loadgen-public> "sudo REPO_URL=<repo> bash -s" < cloud/setup-loadgen.sh
```

Seed once, from any app node:
`pnpm exec medusa exec ./src/scripts/seed-load-test-data.ts`

## 3 — the four experiments

| # | Question | How | Ticket topics |
|---|---|---|---|
| 1 | What does ONE node do? | `capacity.js`, 1 app node, find the arrival rate where p95 crosses 2s | PostgreSQL bottlenecks, payment |
| 2 | Does it scale linearly? | repeat at 2, 3, 4 nodes → plot throughput vs nodes | autoscaling, 100k checkouts |
| 3 | Can it oversell? | `oversell-v2.js` across all nodes at once | inventory locking, order consistency |
| 4 | What breaks it? | point apps at `:5432` (no PgBouncer) until connections exhaust; stop the worker and watch queue depth grow | queue management, Redis |

Experiment 4 is the one that answers "what would have made it fail?" — without
it, a passing result is not evidence of anything.

## 4 — stop paying

```bash
bash cloud/provision.sh stop      # deallocate, keeps disks
bash cloud/provision.sh destroy   # delete the resource group entirely
```

A running rig is ~$0.60/hr. A forgotten one is the only way this exercise
costs real money.
