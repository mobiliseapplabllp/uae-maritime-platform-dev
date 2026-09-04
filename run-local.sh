#!/usr/bin/env bash
# One command to bring the whole platform up on a developer machine.
#
#   ./run-local.sh            install, build, create databases, seed, start everything
#   ./run-local.sh start      start what is already built and seeded
#   ./run-local.sh stop       stop every service and the runtime
#   ./run-local.sh status     what is up and on which port
#   ./run-local.sh update     pull the latest cloud work, rebuild, restart (the daily loop)
#   ./run-local.sh reset      drop the databases and seed again from the shared world
#
# Prerequisites: Node 22+, pnpm 10+, PostgreSQL 16 (role `maritime`, password `maritime`),
# and a NATS server on the PATH. `infra/local/runtime.sh` starts PostgreSQL and NATS for you
# when they are installed but not running.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
LOCAL="${MARITIME_LOCAL_DIR:-$ROOT/.local}"; LOG="$LOCAL/log"; mkdir -p "$LOG"
PGUSER_="${PGUSER:-maritime}"; export PGPASSWORD="${PGPASSWORD:-maritime}"
PGHOST_="${PGHOST:-127.0.0.1}"; PGPORT_="${PGPORT:-5432}"
GATEWAY_PORT=5200; WEB_PORT=5300

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Every service that owns a database, and the database it owns.
db_of() { case "$1" in
  identity-access) echo maritime_identity ;; audit-ledger) echo maritime_audit ;;
  maritime-centre) echo maritime_maritime_centre ;; ai-agents) echo maritime_ai_agents ;;
  ai-assistant) echo maritime_ai_assistant ;; gateway) echo '' ;;
  *) echo "maritime_${1//-/_}" ;;
esac; }

check_prereqs() {
  say "Checking prerequisites"
  command -v node >/dev/null || die "Node is not installed. Install Node 22 or newer."
  local major; major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] || die "Node $major is too old. Install Node 22 or newer."
  ok "node $(node -v)"
  command -v pnpm >/dev/null || die "pnpm is not installed. Run: npm install -g pnpm@10"
  ok "pnpm $(pnpm -v)"
  command -v psql >/dev/null || die "PostgreSQL client tools are not installed. Install PostgreSQL 16."
  ok "psql present"
}

start_runtime() {
  say "Starting PostgreSQL and NATS"
  bash infra/local/runtime.sh start 2>&1 | sed 's/^/   /'
  psql -h "$PGHOST_" -p "$PGPORT_" -U "$PGUSER_" -d postgres -Atc 'select 1' >/dev/null 2>&1 \
    || die "Cannot reach PostgreSQL at $PGHOST_:$PGPORT_ as role '$PGUSER_'. Create the role and database owner first:
     createuser -s maritime && psql -c \"alter role maritime password 'maritime'\""
  ok "PostgreSQL reachable"
}

create_databases() {
  say "Creating databases"
  local made=0
  for s in $(ls services); do
    local db; db=$(db_of "$s"); [ -n "$db" ] || continue
    if ! psql -h "$PGHOST_" -p "$PGPORT_" -U "$PGUSER_" -d postgres -Atc \
         "select 1 from pg_database where datname='$db'" | grep -q 1; then
      createdb -h "$PGHOST_" -p "$PGPORT_" -U "$PGUSER_" "$db" && made=$((made+1))
    fi
  done
  ok "$(ls services | wc -l | tr -d ' ') services, $made database(s) created"
}

install_and_build() {
  say "Installing dependencies"
  pnpm install --prefer-offline 2>&1 | tail -3 | sed 's/^/   /'
  say "Building every package, service and the web app"
  pnpm build 2>&1 | tail -4 | sed 's/^/   /'
  [ -f services/gateway/dist/main.js ] || die "Build failed — see the output above."
  ok "build complete"
}

seed_all() {
  say "Seeding from the shared world (this populates every register)"
  bash infra/local/services.sh seed 2>&1 | grep -Ei "SEED COMPLETE|error|applied" | tail -25 | sed 's/^/   /'
  ok "seed complete"
}

start_services() {
  say "Starting services"
  bash infra/local/services.sh start 2>&1 | sed 's/^/   /'
  say "Starting the web app"
  if curl -fs "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1; then
    ok "web already running on :$WEB_PORT"
  else
    if command -v setsid >/dev/null 2>&1; then
      (cd apps/web && setsid nohup pnpm dev > "$LOG/web.log" 2>&1 < /dev/null & echo $! > "$LOCAL/run/web.pid")
    else
      (cd apps/web && nohup pnpm dev > "$LOG/web.log" 2>&1 < /dev/null & echo $! > "$LOCAL/run/web.pid")
    fi
    for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1 && break; sleep 1; done
    ok "web on :$WEB_PORT"
  fi
}

report() {
  say "Ready"
  local health; health=$(curl -fs "http://127.0.0.1:$GATEWAY_PORT/api/health" 2>/dev/null || echo '')
  printf '   Web app        http://127.0.0.1:%s\n' "$WEB_PORT"
  printf '   API gateway    http://127.0.0.1:%s/api\n' "$GATEWAY_PORT"
  printf '   API reference  http://127.0.0.1:%s/api/docs\n' "$GATEWAY_PORT"
  printf '   Sign in        admin@maritime.example  /  %s\n' "$(node -p "require('./packages/world/dist/index.js').DEMO_PASSWORD" 2>/dev/null || echo '<see packages/world DEMO_PASSWORD>')"
  printf '\n   Every seeded user shares that password. Other roles to try:\n'
  printf '     harbour.master@maritime.example   registrar@maritime.example\n'
  printf '     surveyor@maritime.example         finance.officer@maritime.example\n'
  if [ -n "$health" ]; then
    printf '\n   Gateway health: %s\n' "$(printf '%s' "$health" | head -c 120)"
  else
    warn "the gateway did not answer yet — give it a few seconds, then: ./run-local.sh status"
  fi
  printf '\n   Logs      %s\n   Stop      ./run-local.sh stop\n\n' "$LOG"
}

case "${1:-up}" in
  up)
    check_prereqs; start_runtime; create_databases; install_and_build; seed_all; start_services; report ;;
  start)
    start_runtime; start_services; report ;;
  stop)
    say "Stopping"
    [ -f "$LOCAL/run/web.pid" ] && kill "$(cat "$LOCAL/run/web.pid")" 2>/dev/null
    fuser -k "$WEB_PORT/tcp" 2>/dev/null; rm -f "$LOCAL/run/web.pid"
    bash infra/local/services.sh stop 2>&1 | sed 's/^/   /'
    bash infra/local/runtime.sh stop 2>&1 | sed 's/^/   /'
    ok "stopped" ;;
  update)
    say "Fetching the latest work"
    git remote get-url origin >/dev/null 2>&1 || die "No git remote is configured. Add one first:
     git remote add origin https://github.com/<owner>/<repo>.git"
    BEFORE=$(git rev-parse HEAD)
    git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)" 2>&1 | sed 's/^/   /' || die "pull failed — resolve it, then run ./run-local.sh update again"
    AFTER=$(git rev-parse HEAD)
    if [ "$BEFORE" = "$AFTER" ]; then ok "already up to date"; else
      ok "$(git log --oneline "$BEFORE..$AFTER" | wc -l | tr -d ' ') new commit(s)"
      git log --oneline "$BEFORE..$AFTER" | head -10 | sed 's/^/     /'
    fi
    install_and_build
    say "Restarting services (each applies its own new migrations as it boots)"
    bash infra/local/services.sh stop > /dev/null 2>&1
    bash infra/local/services.sh start > "$LOG/start.log" 2>&1
    ok "$(grep -c 'started' "$LOG/start.log") services restarted"
    # the web dev server picks up source changes itself, so it is only started if it is not already up
    curl -fs -o /dev/null "http://127.0.0.1:$WEB_PORT" 2>/dev/null || start_services
    report ;;
  status)
    bash infra/local/runtime.sh status; bash infra/local/services.sh status
    curl -fs "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1 && echo "web: up (:$WEB_PORT)" || echo "web: down (:$WEB_PORT)" ;;
  reset)
    say "Dropping and reseeding"
    bash infra/local/services.sh stop >/dev/null 2>&1
    for s in $(ls services); do db=$(db_of "$s"); [ -n "$db" ] && dropdb -h "$PGHOST_" -p "$PGPORT_" -U "$PGUSER_" --if-exists "$db"; done
    create_databases; seed_all; start_services; report ;;
  *) echo "usage: ./run-local.sh [up|start|stop|status|update|reset]" >&2; exit 2 ;;
esac
