#!/usr/bin/env bash
# One-time: bring up the data tier on its own cores, build Medusa, seed the
# catalog. Run once per Codespace.  bash lab/bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source lab/layout.sh
layout_print
echo

BACKEND=medusa-backend/apps/backend

docker rm -f mpl-postgres mpl-redis >/dev/null 2>&1 || true

echo "==> postgres on cores $PG_CPUS"
docker run -d --name mpl-postgres --cpuset-cpus="$PG_CPUS" \
  -e POSTGRES_USER=medusa -e POSTGRES_PASSWORD=medusa -e POSTGRES_DB=medusa_perf \
  -p 5432:5432 postgres:16 \
  -c max_connections=300 \
  -c shared_buffers=2GB \
  -c effective_cache_size=6GB \
  -c work_mem=8MB \
  -c max_wal_size=4GB \
  -c checkpoint_completion_target=0.9 \
  -c random_page_cost=1.1 \
  -c shared_preload_libraries=pg_stat_statements \
  -c pg_stat_statements.track=all \
  -c track_io_timing=on >/dev/null

echo "==> redis on core $REDIS_CPUS"
docker run -d --name mpl-redis --cpuset-cpus="$REDIS_CPUS" \
  -p 6379:6379 redis:7 --save '' --appendonly no >/dev/null

printf "==> waiting for postgres"
until docker exec mpl-postgres pg_isready -U medusa -d medusa_perf -q 2>/dev/null; do
  printf "."; sleep 1
done; echo " up"
docker exec mpl-postgres psql -U medusa -d medusa_perf -q \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'

echo "==> writing $BACKEND/.env"
cat > "$BACKEND/.env" <<ENVEOF
NODE_ENV=production
DATABASE_URL=postgres://medusa:medusa@localhost:5432/medusa_perf
REDIS_URL=redis://localhost:6379
DB_POOL_MAX=40
DISABLE_MEDUSA_ADMIN=true
STORE_CORS=http://localhost:8000
ADMIN_CORS=http://localhost:9000
AUTH_CORS=http://localhost:9000
JWT_SECRET=$(openssl rand -hex 24)
COOKIE_SECRET=$(openssl rand -hex 24)
ENVEOF

echo "==> building Medusa (a few minutes)"
( cd "$BACKEND" && pnpm exec medusa build )
cp "$BACKEND/.env" "$BACKEND/.medusa/server/.env"
( cd "$BACKEND/.medusa/server" && pnpm install --prod --ignore-scripts >/dev/null 2>&1 || true )

echo "==> migrations + seed"
( cd "$BACKEND" && pnpm exec medusa db:migrate )
( cd "$BACKEND" && pnpm exec medusa exec ./src/scripts/seed-load-test-data.ts )

echo
echo "bootstrap done."
echo "next:  bash lab/start.sh 1        # start 1 Medusa instance"
echo "       bash lab/run.sh 1 40       # capacity test, 1 node, peak 40/s"
