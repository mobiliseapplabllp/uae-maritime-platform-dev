# PostgreSQL 16 with PostGIS (from the upstream image) plus pgvector, which postgis/postgis does not ship.
#   docker build -f infra/docker/postgres.Dockerfile -t maritime/postgres:16-3.4 infra/docker
FROM postgis/postgis:16-3.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
