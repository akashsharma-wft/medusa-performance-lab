#!/usr/bin/env bash
# Core budget. Sourced by every other lab script.
#
# This is the fix for the flaw that invalidated the laptop results: there, k6,
# PostgreSQL, Redis, four Node processes and ten monitoring containers all
# competed for the same eight cores, so a "34 second p95" was measuring
# contention rather than Medusa. Here each component gets a hard CPU budget
# that nothing else can touch - taskset for processes, --cpuset-cpus for
# containers - so the load generator physically cannot steal cycles from the
# system under test.
NCPU=$(nproc)

if   [ "$NCPU" -ge 16 ]; then
  K6_CPUS=0-1 ; PG_CPUS=2-4 ; REDIS_CPUS=5 ; APP_CPU_START=6 ; APP_CPU_END=15
elif [ "$NCPU" -ge 8 ]; then
  K6_CPUS=0-1 ; PG_CPUS=2-3 ; REDIS_CPUS=4 ; APP_CPU_START=5 ; APP_CPU_END=7
else
  echo "WARNING: only $NCPU cores. Isolation will be weak; use an 8-core Codespace." >&2
  K6_CPUS=0 ; PG_CPUS=1 ; REDIS_CPUS=1 ; APP_CPU_START=2 ; APP_CPU_END=$((NCPU-1))
fi

APP_CPU_COUNT=$((APP_CPU_END - APP_CPU_START + 1))
export NCPU K6_CPUS PG_CPUS REDIS_CPUS APP_CPU_START APP_CPU_END APP_CPU_COUNT

# Cores for app instance N (1-based), one core each, wrapping if we run more
# instances than cores.
app_cpu_for () {
  local n=$1
  echo $(( APP_CPU_START + ((n - 1) % APP_CPU_COUNT) ))
}

layout_print () {
  cat <<LEOF
core budget ($NCPU cores)
  k6         : $K6_CPUS
  postgres   : $PG_CPUS
  redis      : $REDIS_CPUS
  medusa     : $APP_CPU_START-$APP_CPU_END  ($APP_CPU_COUNT cores)
LEOF
}
