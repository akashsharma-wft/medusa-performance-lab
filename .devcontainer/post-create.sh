#!/usr/bin/env bash
set -euo pipefail
echo "==> installing k6, postgres client, redis tools"
sudo apt-get update -qq
sudo apt-get install -y -qq gnupg ca-certificates jq bc postgresql-client redis-tools util-linux
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
     --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list >/dev/null
sudo apt-get update -qq && sudo apt-get install -y -qq k6

echo "==> raising socket limits"
sudo sysctl -w net.ipv4.ip_local_port_range="10000 65535" >/dev/null
sudo sysctl -w net.core.somaxconn=65535 >/dev/null
sudo sysctl -w net.ipv4.tcp_tw_reuse=1 >/dev/null
ulimit -n 65535 || true

echo "==> installing Medusa dependencies"
corepack enable && corepack prepare pnpm@latest --activate
cd medusa-backend && pnpm install --frozen-lockfile

echo
echo "  ready. $(nproc) cores available."
echo "  next:  bash lab/bootstrap.sh"
