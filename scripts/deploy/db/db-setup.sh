#!/usr/bin/env bash
# Create the self-hosted ClawVille Postgres (pgvector 17) on this box.
# Usage: SHARED_BUFFERS=256MB CACHE=1GB MAXCONN=100 bash db-setup.sh
# Idempotent. Never prints secrets.
set -euo pipefail
SHARED_BUFFERS="${SHARED_BUFFERS:-256MB}"
CACHE="${CACHE:-1GB}"
MAXCONN="${MAXCONN:-100}"

mkdir -p /opt/clawville-db/backups /opt/clawville-db/bin
cd /opt/clawville-db
if [ ! -f .env ]; then
  umask 077
  printf 'POSTGRES_PASSWORD=%s\nAPP_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
fi
chmod 600 .env

cat > docker-compose.yml <<YML
# ClawVille app database (self-hosted, replaces Supabase). Private: loopback + coolify network only.
name: clawville-db
services:
  db:
    image: pgvector/pgvector:pg17
    container_name: clawville-db
    restart: unless-stopped
    env_file: .env
    shm_size: 256mb
    command:
      - postgres
      - -c
      - shared_buffers=${SHARED_BUFFERS}
      - -c
      - effective_cache_size=${CACHE}
      - -c
      - max_connections=${MAXCONN}
      - -c
      - work_mem=8MB
      - -c
      - maintenance_work_mem=256MB
      - -c
      - shared_preload_libraries=pg_stat_statements
      - -c
      - log_min_duration_statement=2000
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    networks:
      coolify:
        aliases: [clawville-db]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 20
volumes:
  pgdata:
networks:
  coolify:
    external: true
YML

docker compose up -d
for i in $(seq 1 60); do
  s=$(docker inspect -f '{{.State.Health.Status}}' clawville-db 2>/dev/null || true)
  [ "$s" = healthy ] && break
  sleep 2
done
echo "health=$(docker inspect -f '{{.State.Health.Status}}' clawville-db)"

set -a; . ./.env; set +a
exists=$(docker exec clawville-db psql -U postgres -tAc "select 1 from pg_roles where rolname='clawville'")
if [ "$exists" != 1 ]; then
  docker exec -i clawville-db psql -U postgres -v ON_ERROR_STOP=1 -v app_pw="$APP_PASSWORD" <<'SQL'
CREATE ROLE clawville LOGIN PASSWORD :'app_pw';
CREATE DATABASE clawville OWNER clawville;
SQL
fi
docker exec -i clawville-db psql -U postgres -d clawville -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION clawville;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
ALTER SCHEMA public OWNER TO clawville;
ALTER DATABASE clawville SET search_path TO "$user", public, extensions;
SQL
docker exec clawville-db psql -U postgres -d clawville -tAc "select string_agg(extname||'@'||extversion, ' ') from pg_extension"
docker exec clawville-db psql -U postgres -tAc "select version()"
