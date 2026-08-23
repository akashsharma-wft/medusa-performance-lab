#!/usr/bin/env bash
# Data tier: PostgreSQL 16 + PgBouncer + Redis 7, tuned for a 2 vCPU / 8 GB node.
# Run once on the `db` VM:  sudo bash setup-db.sh
set -euo pipefail

PG_PASS="${PG_PASS:-medusa}"
VNET_CIDR="${VNET_CIDR:-10.10.0.0/16}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release

# --- PostgreSQL 16 from PGDG -------------------------------------------------
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y -qq postgresql-16 postgresql-contrib-16 pgbouncer redis-server

PGCONF=/etc/postgresql/16/main/postgresql.conf
PGHBA=/etc/postgresql/16/main/pg_hba.conf

# --- Tuning ------------------------------------------------------------------
# max_connections is set high deliberately: the "no PgBouncer" experiment needs
# room to hit the ceiling on purpose, and the PgBouncer path never gets close.
cat >> "$PGCONF" <<'PGEOF'

# ---- performance lab tuning (2 vCPU / 8 GB) ----
listen_addresses = '*'
max_connections = 300
shared_buffers = 2GB
effective_cache_size = 6GB
work_mem = 8MB
maintenance_work_mem = 512MB
max_wal_size = 4GB
min_wal_size = 1GB
checkpoint_completion_target = 0.9
random_page_cost = 1.1          # SSD, not spinning rust
effective_io_concurrency = 200
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
track_io_timing = on
PGEOF

echo "host all all ${VNET_CIDR} scram-sha-256" >> "$PGHBA"

systemctl restart postgresql
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQLEOF
ALTER USER postgres WITH PASSWORD '${PG_PASS}';
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='medusa') THEN
    CREATE ROLE medusa LOGIN PASSWORD '${PG_PASS}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE medusa_perf OWNER medusa'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='medusa_perf')\gexec
SQLEOF
sudo -u postgres psql -d medusa_perf -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'

# --- PgBouncer ---------------------------------------------------------------
# transaction pooling: node-postgres does not use server-side prepared
# statements by default, so Medusa is safe in this mode.
cat > /etc/pgbouncer/pgbouncer.ini <<PBEOF
[databases]
medusa_perf = host=127.0.0.1 port=5432 dbname=medusa_perf

[pgbouncer]
listen_addr = *
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 5000
default_pool_size = 40
reserve_pool_size = 10
reserve_pool_timeout = 3
server_lifetime = 3600
server_idle_timeout = 600
ignore_startup_parameters = extra_float_digits
admin_users = medusa
stats_users = medusa
PBEOF

HASH=$(sudo -u postgres psql -tAc "SELECT rolpassword FROM pg_authid WHERE rolname='medusa'")
printf '"medusa" "%s"\n' "$HASH" > /etc/pgbouncer/userlist.txt
chown postgres:postgres /etc/pgbouncer/userlist.txt
chmod 600 /etc/pgbouncer/userlist.txt
systemctl restart pgbouncer && systemctl enable pgbouncer

# --- Redis -------------------------------------------------------------------
sed -i "s/^bind .*/bind 0.0.0.0/"           /etc/redis/redis.conf
sed -i "s/^protected-mode .*/protected-mode no/" /etc/redis/redis.conf
sed -i "s/^# maxmemory .*/maxmemory 1gb/"   /etc/redis/redis.conf
sed -i "s/^appendonly .*/appendonly no/"    /etc/redis/redis.conf
systemctl restart redis-server && systemctl enable redis-server

echo
echo "data tier ready:"
echo "  postgres direct : 5432   (bypasses the pool - used for the failure demo)"
echo "  pgbouncer       : 6432   (the production path)"
echo "  redis           : 6379"
