#!/usr/bin/env bash
# Runs once when the PostgreSQL data directory is initialised: creates one database per service (plus keycloak)
# and enables postgis, pgcrypto and vector in each. pgvector is present in the image built from
# infra/docker/postgres.Dockerfile; on a plain postgis/postgis image the vector step logs a notice and continues.
set -euo pipefail
DATABASES="maritime_identity maritime_mdm maritime_audit maritime_notifications maritime_scheduler maritime_reporting
maritime_workflow maritime_rules maritime_instruments maritime_documents maritime_integration maritime_ships
maritime_seafarers maritime_legislation maritime_centre maritime_inspection maritime_ports maritime_facilities
maritime_revenue maritime_ai keycloak"
for db in $DATABASES; do
  echo "init: creating database $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 \
    || psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c "CREATE DATABASE $db OWNER \"$POSTGRES_USER\""
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<SQL
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO \$\$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector is not available in this image (%): build infra/docker/postgres.Dockerfile', SQLERRM;
END
\$\$;
SQL
done
echo "init: databases ready"
