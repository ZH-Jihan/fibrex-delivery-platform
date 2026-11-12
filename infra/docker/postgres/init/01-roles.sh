#!/bin/sh
# Creates the database roles Fibrex relies on (docs/PLAN.md section 2.2).
#
# Runs once, when the PostgreSQL container initialises an empty data directory.
# Development only: production uses a managed PostgreSQL where the same roles are
# created by infrastructure code.
#
#   fibrex_owner  owns the database and every table; runs migrations. CREATEDB is granted
#                 here only so `prisma migrate dev` can create its shadow database.
#   fibrex_app    used by the API and worker. NOBYPASSRLS means row-level security always
#                 applies. Table grants (no DELETE) are given by the migrations.
#   fibrex_bi     read-only access to the reporting schema for BI tools.
set -eu

: "${FIBREX_OWNER_PASSWORD:?FIBREX_OWNER_PASSWORD is required}"
: "${FIBREX_APP_PASSWORD:?FIBREX_APP_PASSWORD is required}"
: "${FIBREX_BI_PASSWORD:?FIBREX_BI_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" \
  -v owner_pw="$FIBREX_OWNER_PASSWORD" \
  -v app_pw="$FIBREX_APP_PASSWORD" \
  -v bi_pw="$FIBREX_BI_PASSWORD" <<'SQL'
CREATE ROLE fibrex_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER CREATEDB NOCREATEROLE;
CREATE ROLE fibrex_app   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE fibrex_bi    LOGIN PASSWORD :'bi_pw'    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

ALTER DATABASE :"db" OWNER TO fibrex_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO fibrex_app;
GRANT CONNECT ON DATABASE :"db" TO fibrex_bi;

-- Nobody may create objects in public; module schemas are created by migrations.
ALTER SCHEMA public OWNER TO fibrex_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Extensions used by the schema (installed by the superuser so the owner role needs no
-- extra rights): trigram search, GiST exclusion constraints for effective-dated rows,
-- and crypto helpers for hashing.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
