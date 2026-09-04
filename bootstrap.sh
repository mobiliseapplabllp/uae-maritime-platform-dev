#!/usr/bin/env bash
# One command. Installs whatever is missing, sets up the databases, builds, seeds,
# starts all 21 services and the web app, and opens it.
#
#     ./bootstrap.sh
#
# Supports macOS (Homebrew), Debian/Ubuntu (apt) and Fedora/RHEL (dnf). On anything
# else it stops and prints exactly what to install by hand — it never guesses.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$ROOT"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
work() { printf '   \033[36m→\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

OS=unknown; PKG=
case "$(uname -s)" in
  Darwin) OS=macos; command -v brew >/dev/null && PKG=brew ;;
  Linux)  OS=linux
          command -v apt-get >/dev/null && PKG=apt
          command -v dnf     >/dev/null && PKG=dnf ;;
esac

install_with() {           # install_with <friendly> <brew formula> <apt package> <dnf package>
  local name="$1" b="$2" a="$3" d="$4"
  case "$PKG" in
    brew) work "installing $name with Homebrew"; brew install "$b" >/dev/null 2>&1 || brew install "$b" ;;
    apt)  work "installing $name with apt"; sudo apt-get update -qq && sudo apt-get install -y -qq $a ;;
    dnf)  work "installing $name with dnf"; sudo dnf install -y -q $d ;;
    *)    die "$name is missing and this script cannot install it on your system.
     Install $name, then run ./bootstrap.sh again." ;;
  esac
}

bold "1/6  Checking what you already have"
NODE_OK=0
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; then
  NODE_OK=1; ok "Node $(node -v)"
fi
[ $NODE_OK -eq 1 ] || { install_with "Node 22" node@22 nodejs npm nodejs npm
  [ "$PKG" = brew ] && { brew link --overwrite --force node@22 >/dev/null 2>&1 || true; export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"; }
  command -v node >/dev/null || die "Node still not on the PATH. Open a new terminal and run ./bootstrap.sh again."
  ok "Node $(node -v)"; }

if command -v pnpm >/dev/null; then ok "pnpm $(pnpm -v)"
else work "installing pnpm"; npm install -g pnpm@10 >/dev/null 2>&1 || sudo npm install -g pnpm@10 || die "could not install pnpm"; ok "pnpm $(pnpm -v)"; fi

if command -v psql >/dev/null; then ok "PostgreSQL client $(psql --version | awk '{print $3}')"
else install_with "PostgreSQL 16" postgresql@16 postgresql postgresql-server postgresql
     [ "$PKG" = brew ] && export PATH="$(brew --prefix)/opt/postgresql@16/bin:$PATH"
     ok "PostgreSQL installed"; fi

if command -v nats-server >/dev/null; then ok "NATS $(nats-server --version | awk '{print $NF}')"
else install_with "NATS server" nats-server nats-server nats-server || true
     command -v nats-server >/dev/null && ok "NATS installed" \
       || warn "NATS not installed — services will fall back to an in-process bus (single-node only)"; fi

bold "2/6  Starting PostgreSQL"
if ! pg_isready -q 2>/dev/null; then
  case "$PKG" in
    brew) brew services start postgresql@16 >/dev/null 2>&1 || brew services start postgresql >/dev/null 2>&1 ;;
    apt|dnf) sudo systemctl start postgresql 2>/dev/null || sudo service postgresql start 2>/dev/null ;;
  esac
  for _ in $(seq 1 30); do pg_isready -q 2>/dev/null && break; sleep 1; done
fi
pg_isready -q 2>/dev/null || die "PostgreSQL will not start. Start it, then run ./bootstrap.sh again."
ok "PostgreSQL is accepting connections"

bold "3/6  Creating the database role"
export PGPASSWORD=maritime
if psql -h 127.0.0.1 -U maritime -d postgres -Atc 'select 1' >/dev/null 2>&1; then
  ok "role 'maritime' already works"
else
  ADMIN_USER="${SUDO_USER:-$USER}"
  for as in "$ADMIN_USER" postgres; do
    if PGPASSWORD= psql -U "$as" -d postgres -Atc 'select 1' >/dev/null 2>&1; then
      work "creating role 'maritime' as $as"
      PGPASSWORD= psql -U "$as" -d postgres -qc "create role maritime with login superuser password 'maritime'" 2>/dev/null
      break
    elif sudo -n -u postgres psql -d postgres -Atc 'select 1' >/dev/null 2>&1; then
      work "creating role 'maritime' as the postgres system user"
      sudo -u postgres psql -d postgres -qc "create role maritime with login superuser password 'maritime'" 2>/dev/null
      break
    fi
  done
  psql -h 127.0.0.1 -U maritime -d postgres -Atc 'select 1' >/dev/null 2>&1 \
    || die "could not create the 'maritime' role. Create it by hand, then run ./bootstrap.sh again:
       createuser -s maritime
       psql -d postgres -c \"alter role maritime password 'maritime'\""
  ok "role 'maritime' created"
fi

bold "4/6  Installing dependencies and building (this is the slow part, 8-15 minutes)"
pnpm install --prefer-offline 2>&1 | tail -2 | sed 's/^/   /'
pnpm build 2>&1 | tail -3 | sed 's/^/   /'
[ -f services/gateway/dist/main.js ] || die "the build did not finish — see the output above"
ok "built"

bold "5/6  Creating and seeding the databases"
bash infra/local/runtime.sh start 2>&1 | sed 's/^/   /'
for s in $(ls services); do
  case "$s" in
    identity-access) db=maritime_identity ;; audit-ledger) db=maritime_audit ;;
    maritime-centre) db=maritime_maritime_centre ;; ai-agents) db=maritime_ai_agents ;;
    ai-assistant) db=maritime_ai_assistant ;; gateway) continue ;;
    *) db="maritime_${s//-/_}" ;;
  esac
  psql -h 127.0.0.1 -U maritime -d postgres -Atc "select 1 from pg_database where datname='$db'" | grep -q 1 \
    || createdb -h 127.0.0.1 -U maritime "$db"
done
ok "21 databases ready"
work "seeding from the shared world — every register, one consistent story"
SEEDED=$(bash infra/local/services.sh seed 2>&1 | grep -c "SEED COMPLETE")
ok "seeded $SEEDED services"

bold "6/6  Starting everything"
LOGDIR="${MARITIME_LOCAL_DIR:-$ROOT/.local}/log"; mkdir -p "$LOGDIR"
# not piped: the detached services would hold the pipe open and the reader would never see EOF
bash infra/local/services.sh start > "$LOGDIR/start.log" 2>&1
ok "$(grep -c 'started\|already running' "$LOGDIR/start.log") services running"
work "starting the web app"
( cd "$ROOT/apps/web" && setsid nohup pnpm dev > "$LOGDIR/web.log" 2>&1 < /dev/null & )
# Vite pre-bundles every dependency on a cold start, which on a first run can take
# well over a minute on a laptop; wait generously, and show the log if it never binds.
WEB_OK=0
for _ in $(seq 1 240); do
  if curl -fs -o /dev/null http://127.0.0.1:5300 2>/dev/null; then WEB_OK=1; break; fi
  sleep 1
done
if [ $WEB_OK -eq 1 ]; then ok "web app on :5300"; else
  warn "the web app did not bind within four minutes. The last lines of $LOGDIR/web.log:"
  tail -15 "$LOGDIR/web.log" 2>/dev/null | sed 's/^/       /' || echo "       (no log was written — the dev server never started)"
  warn "start it yourself with:  cd apps/web && pnpm dev"
fi

PWORD=$(node -p "require('$ROOT/packages/world/dist/index.js').DEMO_PASSWORD" 2>/dev/null || echo 'Demo@2026')
printf '\n\033[1m═══════════════════════════════════════════════════════════\033[0m\n'
printf '\033[1m  The platform is running\033[0m\n'
printf '\033[1m═══════════════════════════════════════════════════════════\033[0m\n\n'
printf '   Web app        http://127.0.0.1:5300\n'
printf '   API gateway    http://127.0.0.1:5200/api\n'
printf '   API reference  http://127.0.0.1:5200/api/docs\n\n'
printf '   Sign in        admin@maritime.example\n'
printf '   Password       %s\n\n' "$PWORD"
printf '   Other roles (same password):\n'
printf '     ahmed.al.mansoori@maritime.example      Harbour Master\n'
printf '     abdullah.al.mazrouei@maritime.example   Registrar of Ships\n'
printf '     aisha.al.hosani@maritime.example        Marine Surveyor\n'
printf '     alia.al.kaabi@maritime.example          Finance Officer\n\n'
printf '   Stop it        ./run-local.sh stop\n'
printf '   Start again    ./run-local.sh start\n\n'
command -v open >/dev/null && open http://127.0.0.1:5300 2>/dev/null
command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:5300 2>/dev/null
exit 0
