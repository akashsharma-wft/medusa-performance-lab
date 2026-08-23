#!/usr/bin/env bash
# App tier: one Medusa v2 instance per VM.
# Run on each app VM:
#   sudo REPO_URL=https://github.com/<you>/medusa-performance-lab.git \
#        DB_HOST=10.10.1.10 REDIS_HOST=10.10.1.10 bash setup-app.sh
set -euo pipefail

REPO_URL="${REPO_URL:?set REPO_URL to your GitHub repo}"
DB_HOST="${DB_HOST:?set DB_HOST to the db VM private IP}"
REDIS_HOST="${REDIS_HOST:-$DB_HOST}"
DB_PORT="${DB_PORT:-6432}"          # 6432 = PgBouncer, 5432 = direct (failure demo)
PG_PASS="${PG_PASS:-medusa}"
WORKER_MODE="${WORKER_MODE:-server}" # server | worker | shared
DB_POOL_MAX="${DB_POOL_MAX:-40}"
APP_USER="${SUDO_USER:-azureuser}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git build-essential

# --- Node 22 -----------------------------------------------------------------
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs
corepack enable && corepack prepare pnpm@latest --activate

# --- Raise the file-descriptor ceiling ---------------------------------------
# A Node process fronting thousands of keep-alive sockets will exhaust the
# default 1024 long before Medusa itself runs out of anything.
cat >> /etc/security/limits.conf <<'LEOF'
*   soft  nofile  65535
*   hard  nofile  65535
LEOF
sysctl -w net.core.somaxconn=65535 >/dev/null
sysctl -w net.ipv4.tcp_max_syn_backlog=65535 >/dev/null
sysctl -w net.ipv4.ip_local_port_range="10000 65535" >/dev/null

# --- Application -------------------------------------------------------------
APP_ROOT=/opt/medusa-lab
rm -rf "$APP_ROOT"
git clone --depth 1 "$REPO_URL" "$APP_ROOT"
BACKEND="$APP_ROOT/medusa-backend/apps/backend"

cat > "$BACKEND/.env" <<ENVEOF
NODE_ENV=production
DATABASE_URL=postgres://medusa:${PG_PASS}@${DB_HOST}:${DB_PORT}/medusa_perf
REDIS_URL=redis://${REDIS_HOST}:6379
DB_POOL_MAX=${DB_POOL_MAX}
MEDUSA_WORKER_MODE=${WORKER_MODE}
DISABLE_MEDUSA_ADMIN=true
STORE_CORS=http://localhost:8000
ADMIN_CORS=http://localhost:9000
AUTH_CORS=http://localhost:9000
JWT_SECRET=$(openssl rand -hex 24)
COOKIE_SECRET=$(openssl rand -hex 24)
ENVEOF

cd "$APP_ROOT/medusa-backend"
pnpm install --frozen-lockfile
cd "$BACKEND"
pnpm exec medusa build
chown -R "$APP_USER":"$APP_USER" "$APP_ROOT"

# --- systemd -----------------------------------------------------------------
# EnvironmentFile lets us flip default/optimized and server/worker between runs
# without rebuilding anything: edit /etc/medusa-lab.env, restart, re-measure.
cat > /etc/medusa-lab.env <<RUNEOF
MEDUSA_WORKER_MODE=${WORKER_MODE}
DB_POOL_MAX=${DB_POOL_MAX}
DISABLE_OPTIMIZATIONS=false
RUNEOF

cat > /etc/systemd/system/medusa.service <<SVCEOF
[Unit]
Description=Medusa v2 (performance lab)
After=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${BACKEND}/.medusa/server
EnvironmentFile=/etc/medusa-lab.env
Environment=NODE_ENV=production
Environment=PORT=9000
ExecStart=/usr/bin/npx medusa start
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
SVCEOF

cd "$BACKEND/.medusa/server" && cp "$BACKEND/.env" .env 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now medusa

echo
echo "app node ready on :9000  (worker_mode=${WORKER_MODE}, db=${DB_HOST}:${DB_PORT})"
echo "flip config in /etc/medusa-lab.env then: sudo systemctl restart medusa"
