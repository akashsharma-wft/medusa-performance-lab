#!/usr/bin/env bash
# Load generator: k6 and nothing else. This box never runs anything under test.
#   sudo REPO_URL=https://github.com/<you>/medusa-performance-lab.git bash setup-loadgen.sh
set -euo pipefail
REPO_URL="${REPO_URL:?set REPO_URL}"
APP_USER="${SUDO_USER:-azureuser}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gnupg git jq

# --- k6 ----------------------------------------------------------------------
gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  > /etc/apt/sources.list.d/k6.list
apt-get update -qq && apt-get install -y -qq k6

# --- Headroom for a machine opening tens of thousands of sockets -------------
cat >> /etc/security/limits.conf <<'LEOF'
*   soft  nofile  1048576
*   hard  nofile  1048576
LEOF
sysctl -w net.ipv4.ip_local_port_range="10000 65535" >/dev/null
sysctl -w net.ipv4.tcp_tw_reuse=1 >/dev/null
sysctl -w net.core.somaxconn=65535 >/dev/null

git clone --depth 1 "$REPO_URL" /opt/medusa-lab
chown -R "$APP_USER":"$APP_USER" /opt/medusa-lab
mkdir -p /opt/medusa-lab/results/cloud && chown "$APP_USER":"$APP_USER" /opt/medusa-lab/results/cloud

echo
echo "loadgen ready. k6 $(k6 version)"
echo "scripts in /opt/medusa-lab/k6"
