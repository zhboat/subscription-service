#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/deploy/compose/docker-compose.yml}"
BACKEND_SERVICE="${BACKEND_SERVICE:-backend}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

ENV_BACKUP=""
BACKEND_STOPPED=0
COMPOSE_CMD=()

log() {
  printf '[postgres-migration] %s\n' "$*"
}

die() {
  printf '[postgres-migration] ERROR: %s\n' "$*" >&2
  exit 1
}

env_get() {
  local key="$1"
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    $0 ~ "^[[:space:]]*" key "=" {
      sub(/^[[:space:]]*[^=]*=/, "")
      sub(/\r$/, "")
      print
      exit
    }
  ' "$ENV_FILE"
}

strip_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

env_default() {
  local key="$1"
  local fallback="$2"
  local value
  value="$(env_get "$key" || true)"
  if [[ -z "$value" ]]; then
    printf '%s' "$fallback"
  else
    strip_quotes "$value"
  fi
}

env_set() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"

  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*" key "=" {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        print key "=" value
      }
    }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

compose() {
  "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

running_container_named() {
  local name="$1"
  docker ps --format '{{.Names}}' | grep -Fxq "$name"
}

find_container() {
  local preferred="$1"
  local image_regex="$2"

  if [[ -n "$preferred" ]] && running_container_named "$preferred"; then
    printf '%s' "$preferred"
    return
  fi

  docker ps --format '{{.Names}} {{.Image}}' \
    | awk -v image_regex="$image_regex" '$2 ~ image_regex { print $1; exit }'
}

container_aliases() {
  local container="$1"
  docker inspect "$container" --format '{{range .NetworkSettings.Networks}}{{range .Aliases}}{{println .}}{{end}}{{end}}' 2>/dev/null || true
}

detect_postgres_host() {
  local container="$1"
  local aliases
  aliases="$(container_aliases "$container")"

  if printf '%s\n' "$aliases" | grep -Fxq postgresql; then
    printf 'postgresql'
  elif printf '%s\n' "$aliases" | grep -Fxq postgres; then
    printf 'postgres'
  else
    printf '%s' "$container"
  fi
}

generate_secret() {
  openssl rand -hex 24
}

rollback_on_error() {
  local code=$?
  trap - ERR

  log "migration failed; restoring the previous .env"
  if [[ -n "$ENV_BACKUP" && -f "$ENV_BACKUP" ]]; then
    cp "$ENV_BACKUP" "$ENV_FILE"
  fi

  if [[ "$BACKEND_STOPPED" == "1" ]]; then
    log "starting backend with the previous database configuration"
    compose up -d "$BACKEND_SERVICE" >/dev/null 2>&1 || true
  fi

  exit "$code"
}

ensure_files() {
  [[ -f "$ENV_FILE" ]] || die "missing env file: $ENV_FILE"
  [[ -f "$COMPOSE_FILE" ]] || die "missing compose file: $COMPOSE_FILE"
  command -v docker >/dev/null 2>&1 || die "docker is required"
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    die "docker compose v2 or docker-compose is required"
  fi
  command -v openssl >/dev/null 2>&1 || die "openssl is required"
}

create_postgres_database() {
  local pg_container="$1"
  local pg_admin_user="$2"
  local pg_database="$3"
  local pg_user="$4"
  local pg_password="$5"

  log "ensuring PostgreSQL role and database exist"
  docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U "$pg_admin_user" -d postgres \
    -v app_role="$pg_user" \
    -v app_password="$pg_password" \
    -v app_db="$pg_database" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_role', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_role', :'app_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'app_db', :'app_role') \gexec
SQL

  docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -U "$pg_admin_user" -d "$pg_database" \
    -v app_role="$pg_user" <<'SQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_role') \gexec
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'app_role') \gexec
SQL
}

backup_mysql() {
  local mysql_container="$1"
  local mysql_database="$2"
  local mysql_user="$3"
  local mysql_password="$4"
  local mysql_root_password="$5"
  local backup_file="$BACKUP_DIR/subscription-mysql-before-postgres-$TIMESTAMP.sql"

  mkdir -p "$BACKUP_DIR"

  log "writing MySQL backup to $backup_file"
  if [[ -n "$mysql_root_password" ]]; then
    docker exec -e MYSQL_PWD="$mysql_root_password" "$mysql_container" \
      mysqldump -uroot --single-transaction --routines --triggers "$mysql_database" > "$backup_file"
  else
    docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
      mysqldump -u"$mysql_user" --single-transaction --routines --triggers "$mysql_database" > "$backup_file"
  fi
}

print_mysql_counts() {
  local mysql_container="$1"
  local mysql_database="$2"
  local mysql_user="$3"
  local mysql_password="$4"
  local mysql_root_password="$5"
  local user_arg="-u$mysql_user"
  local pass_value="$mysql_password"

  if [[ -n "$mysql_root_password" ]]; then
    user_arg="-uroot"
    pass_value="$mysql_root_password"
  fi

  docker exec -e MYSQL_PWD="$pass_value" "$mysql_container" mysql "$user_arg" -N -B "$mysql_database" -e "
    SELECT 'sub_users', COUNT(*) FROM sub_users
    UNION ALL SELECT 'sub_tokens', COUNT(*) FROM sub_tokens
    UNION ALL SELECT 'sub_user_stats', COUNT(*) FROM sub_user_stats;
  "
}

print_postgres_counts() {
  local pg_container="$1"
  local pg_admin_user="$2"
  local pg_database="$3"

  docker exec "$pg_container" psql -U "$pg_admin_user" -d "$pg_database" -At -c "
    SELECT 'sub_users|' || COUNT(*) FROM sub_users
    UNION ALL SELECT 'sub_tokens|' || COUNT(*) FROM sub_tokens
    UNION ALL SELECT 'sub_user_stats|' || COUNT(*) FROM sub_user_stats
    ORDER BY 1;
  "
}

main() {
  ensure_files
  trap rollback_on_error ERR

  mkdir -p "$BACKUP_DIR"
  ENV_BACKUP="$BACKUP_DIR/.env-before-postgres-$TIMESTAMP"
  cp "$ENV_FILE" "$ENV_BACKUP"

  local mysql_database mysql_user mysql_password mysql_root_password mysql_host mysql_container
  local pg_database pg_user pg_password pg_host pg_container pg_admin_user

  mysql_database="$(env_default MYSQL_DATABASE subscription)"
  mysql_user="$(env_default MYSQL_USER subscription)"
  mysql_password="$(env_default MYSQL_PASSWORD "")"
  mysql_root_password="$(env_default MYSQL_ROOT_PASSWORD "")"
  mysql_host="$(env_default MYSQL_HOST mysql)"

  pg_database="$(env_default POSTGRES_DATABASE subscription)"
  pg_user="$(env_default POSTGRES_USER subscription)"
  pg_password="$(env_default POSTGRES_PASSWORD "")"

  mysql_container="${MYSQL_CONTAINER:-$(find_container "$mysql_host" '^mysql:')}"
  [[ -n "$mysql_container" ]] || die "could not find a running MySQL container; set MYSQL_CONTAINER=..."

  pg_container="${POSTGRES_ADMIN_CONTAINER:-$(find_container "$(env_default POSTGRES_HOST "")" '^postgres:')}"
  [[ -n "$pg_container" ]] || die "could not find a running PostgreSQL container; set POSTGRES_ADMIN_CONTAINER=..."

  pg_admin_user="${POSTGRES_ADMIN_USER:-$(docker exec "$pg_container" sh -lc 'printf "%s" "${POSTGRES_USER:-postgres}"')}"
  [[ -n "$pg_admin_user" ]] || pg_admin_user="postgres"

  pg_host="$(env_default POSTGRES_HOST "")"
  if [[ -z "$pg_host" || "$pg_host" == "postgres" ]]; then
    pg_host="$(detect_postgres_host "$pg_container")"
  fi

  if [[ -z "$pg_password" || "$pg_password" == "CHANGE_ME" ]]; then
    pg_password="$(generate_secret)"
  fi

  log "using MySQL container: $mysql_container"
  log "using PostgreSQL container: $pg_container"
  log "using PostgreSQL host from backend network: $pg_host"

  create_postgres_database "$pg_container" "$pg_admin_user" "$pg_database" "$pg_user" "$pg_password"

  env_set SUB_DB_CLIENT postgres
  env_set POSTGRES_HOST "$pg_host"
  env_set POSTGRES_PORT "$(env_default POSTGRES_PORT 5432)"
  env_set POSTGRES_DATABASE "$pg_database"
  env_set POSTGRES_USER "$pg_user"
  env_set POSTGRES_PASSWORD "$pg_password"
  env_set POSTGRES_SSL "$(env_default POSTGRES_SSL false)"

  log "building backend image before downtime"
  compose build "$BACKEND_SERVICE"

  log "stopping backend to freeze MySQL writes"
  compose stop "$BACKEND_SERVICE"
  BACKEND_STOPPED=1

  backup_mysql "$mysql_container" "$mysql_database" "$mysql_user" "$mysql_password" "$mysql_root_password"

  log "source MySQL row counts"
  print_mysql_counts "$mysql_container" "$mysql_database" "$mysql_user" "$mysql_password" "$mysql_root_password"

  log "running MySQL to PostgreSQL data migration"
  compose run --rm --no-deps "$BACKEND_SERVICE" npm run migrate:mysql-to-postgres

  log "target PostgreSQL row counts"
  print_postgres_counts "$pg_container" "$pg_admin_user" "$pg_database"

  log "starting backend with PostgreSQL"
  compose up -d "$BACKEND_SERVICE"
  BACKEND_STOPPED=0

  log "backend health"
  compose ps "$BACKEND_SERVICE"
  log "done; previous .env backup: $ENV_BACKUP"
}

main "$@"
