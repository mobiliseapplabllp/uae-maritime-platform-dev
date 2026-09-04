#!/usr/bin/env bash
# Local runtime for development without container images: native PostgreSQL 16
# (PostGIS + pgvector), NATS JetStream and Keycloak, each on a fixed port.
# Usage: infra/local/runtime.sh start|stop|status|reset
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL="${MARITIME_LOCAL_DIR:-$ROOT/.local}"
BIN="$LOCAL/bin"; RUN="$LOCAL/run"; LOG="$LOCAL/log"
mkdir -p "$RUN" "$LOG"
PG_PORT="${PG_PORT:-5432}"; NATS_PORT="${NATS_PORT:-4222}"; KC_PORT="${KC_PORT:-8180}"
PG_USER="${PG_USER:-maritime}"; PG_PASSWORD="${PG_PASSWORD:-maritime}"
KC_HOME="$(ls -d "$LOCAL"/keycloak-* 2>/dev/null | head -1 || true)"

pg_start() {
  if pg_isready -q -p "$PG_PORT"; then echo "postgres: already up (:$PG_PORT)"; return; fi
  if command -v pg_ctlcluster >/dev/null; then pg_ctlcluster 16 main start; else
    su postgres -c "pg_ctl -D /var/lib/postgresql/16/main -l $LOG/postgres.log start"; fi
  for _ in $(seq 1 30); do pg_isready -q -p "$PG_PORT" && break; sleep 1; done
  su postgres -c "psql -v ON_ERROR_STOP=1 -tAc \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$PG_USER') THEN CREATE ROLE $PG_USER LOGIN PASSWORD '$PG_PASSWORD' SUPERUSER; END IF; END \\\$\\\$;\"" >/dev/null
  echo "postgres: up (:$PG_PORT, role $PG_USER)"
}
pg_stop() { command -v pg_ctlcluster >/dev/null && pg_ctlcluster 16 main stop || true; echo "postgres: stopped"; }

nats_start() {
  if curl -fs "http://127.0.0.1:8222/healthz" >/dev/null 2>&1; then echo "nats: already up (:$NATS_PORT)"; return; fi
  # a copy vendored under .local/bin wins; otherwise take whatever the package manager installed
  local exe="$BIN/nats-server"
  [ -x "$exe" ] || exe="$(command -v nats-server 2>/dev/null)"
  if [ -z "$exe" ]; then
    echo "nats: not installed — services will fall back to an in-process bus (EVENT_BUS=memory)."
    echo "      install it with:  brew install nats-server   (or see https://nats.io/download/)"
    return
  fi
  nohup "$exe" -js -sd "$RUN/nats-data" -p "$NATS_PORT" -m 8222 > "$LOG/nats.log" 2>&1 &
  echo $! > "$RUN/nats.pid"
  for _ in $(seq 1 20); do curl -fs "http://127.0.0.1:8222/healthz" >/dev/null 2>&1 && break; sleep 1; done
  if curl -fs "http://127.0.0.1:8222/healthz" >/dev/null 2>&1; then echo "nats: up (:$NATS_PORT, monitor :8222)"
  else echo "nats: FAILED to start — see $LOG/nats.log"; tail -5 "$LOG/nats.log" 2>/dev/null | sed 's/^/      /'; fi
}
nats_stop() { [ -f "$RUN/nats.pid" ] && kill "$(cat "$RUN/nats.pid")" 2>/dev/null || true; rm -f "$RUN/nats.pid"; echo "nats: stopped"; }

kc_start() {
  if curl -fs "http://127.0.0.1:$KC_PORT/realms/master" >/dev/null 2>&1; then echo "keycloak: already up (:$KC_PORT)"; return; fi
  [ -n "$KC_HOME" ] || { echo "keycloak: distribution not found under $LOCAL" >&2; return 1; }
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='keycloak'\"" | grep -q 1 || su postgres -c "createdb -O $PG_USER keycloak"
  KC_BOOTSTRAP_ADMIN_USERNAME="${KC_ADMIN:-admin}" KC_BOOTSTRAP_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-admin}" \
  nohup "$KC_HOME/bin/kc.sh" start-dev --http-port "$KC_PORT" --db postgres \
      --db-url "jdbc:postgresql://127.0.0.1:$PG_PORT/keycloak" --db-username "$PG_USER" --db-password "$PG_PASSWORD" \
      --import-realm > "$LOG/keycloak.log" 2>&1 &
  echo $! > "$RUN/keycloak.pid"
  for _ in $(seq 1 90); do curl -fs "http://127.0.0.1:$KC_PORT/realms/master" >/dev/null 2>&1 && break; sleep 1; done
  echo "keycloak: up (:$KC_PORT)"
}
kc_stop() { [ -f "$RUN/keycloak.pid" ] && kill "$(cat "$RUN/keycloak.pid")" 2>/dev/null || true; rm -f "$RUN/keycloak.pid"; echo "keycloak: stopped"; }

status() {
  pg_isready -q -p "$PG_PORT" && echo "postgres: up" || echo "postgres: down"
  curl -fs http://127.0.0.1:8222/healthz >/dev/null 2>&1 && echo "nats: up" || echo "nats: down"
  curl -fs "http://127.0.0.1:$KC_PORT/realms/master" >/dev/null 2>&1 && echo "keycloak: up" || echo "keycloak: down"
}
case "${1:-status}" in
  start) pg_start; nats_start; kc_start ;;
  stop) kc_stop; nats_stop; pg_stop ;;
  status) status ;;
  reset) kc_stop; nats_stop; rm -rf "$RUN/nats-data"; echo "nats data cleared" ;;
  *) echo "usage: $0 start|stop|status|reset" >&2; exit 2 ;;
esac
