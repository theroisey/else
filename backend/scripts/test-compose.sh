#!/bin/sh
# Test only an isolated committed checkout, unique project, and disposable volume.
set +x
set -eu
cd "$(dirname "$0")/../.."
task_revision=$(git rev-parse HEAD)
task_directory=$(mktemp -d)
task_project="else-ci-$(openssl rand -hex 6)"
task_initialized=false
compose() {
  docker compose --project-name "$task_project" --project-directory "$task_directory" \
    --file "$task_directory/docker-compose.yml" --file "$task_directory/docker-compose.ci.yml" "$@"
}
compose_production() {
  compose --file "$task_directory/docker-compose.production.yml" "$@"
}
cleanup() {
  task_result=$?
  trap - EXIT INT TERM
  if [ "$task_initialized" = true ]; then
    if [ "$task_result" -ne 0 ]; then
      compose logs --no-color --tail 100 2>&1 | python3 "$task_directory/backend/scripts/redact-compose-logs.py" "$task_directory/.env" || true
    fi
    compose down --volumes --remove-orphans >/dev/null || task_result=1
  fi
  rm -rf "$task_directory"
  exit "$task_result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git archive HEAD | tar -x -C "$task_directory"
sh "$task_directory/docker/dev/prepare.sh"
FRONTEND_PORT=0
CI_REVISION=$task_revision
export FRONTEND_PORT CI_REVISION
compose config --quiet
compose_production config --quiet
task_initialized=true
if [ -n "${CODEX_PROXY_CERT:-}" ]; then
  compose --file "$task_directory/docker-compose.proxy.yml" build frontend backend migrate
else
  compose build frontend backend migrate
fi
compose up -d --wait postgres
compose run --rm migrate up
compose run --rm migrate down
compose run --rm migrate up
compose exec -T postgres psql -U postgres -d else -v ON_ERROR_STOP=1 -c 'GRANT USAGE ON SCHEMA app TO else_runtime' >/dev/null

runtime_query() {
  compose exec -T postgres sh -eu -c '
    export PGPASSWORD="$RUNTIME_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT=/opt/else/tls-input/ca.crt
    exec psql -h postgres -U else_runtime -d else -v ON_ERROR_STOP=1 -Atc "$1"
  ' sh "$1"
}
[ "$(runtime_query 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')" = t ]
[ "$(runtime_query "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname = current_user")" = f ]
for task_sql in 'CREATE SCHEMA forbidden_ci' 'CREATE TABLE public.forbidden_ci (id integer)' 'SELECT * FROM public.goose_db_version'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Runtime privilege boundary failed.' >&2; exit 1; fi
done
if compose exec -T postgres sh -eu -c '
  export PGPASSWORD="$RUNTIME_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT=/opt/else/tls-input/ca.crt
  psql -h localhost -U else_runtime -d else -v ON_ERROR_STOP=1 -c "SELECT 1"
' >/dev/null 2>&1; then echo 'TLS accepted the wrong hostname.' >&2; exit 1; fi

compose up -d --wait
task_address=$(compose port frontend 5173)
task_url="http://$task_address"
curl --fail --silent --show-error "$task_url/" >/dev/null
curl --fail --silent --show-error "$task_url/health" >/dev/null
curl --fail --silent --show-error "$task_url/ready" >/dev/null
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/unknown")" = 404 ]
compose stop postgres >/dev/null
curl --fail --silent --show-error "$task_url/health" >/dev/null
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/ready")" = 503 ]
compose up -d --wait postgres
task_attempt=0
until curl --fail --silent "$task_url/ready" >/dev/null; do
  task_attempt=$((task_attempt + 1))
  [ "$task_attempt" -lt 30 ] || { echo 'Readiness did not recover.' >&2; exit 1; }
  sleep 1
done

# Synthetic fixture exists only in this unique project's disposable volume.
compose exec -T postgres psql -U postgres -d else -v ON_ERROR_STOP=1 -c 'CREATE TABLE app.ci_persistence (value text); INSERT INTO app.ci_persistence VALUES ($$synthetic-ci$$)' >/dev/null
compose down >/dev/null
compose up -d --wait postgres
[ "$(compose exec -T postgres psql -U postgres -d else -Atc 'SELECT value FROM app.ci_persistence')" = synthetic-ci ]
compose exec -T postgres psql -U postgres -d else -v ON_ERROR_STOP=1 -c 'DROP TABLE app.ci_persistence' >/dev/null
compose run --rm migrate status

if [ -n "${CODEX_PROXY_CERT:-}" ]; then
  compose_production --file "$task_directory/docker-compose.proxy.yml" build frontend backend migrate
else
  compose_production build frontend backend migrate
fi
compose_production up -d --wait
task_address=$(compose_production port frontend 8080)
task_url="http://$task_address"
for task_path in / /status /health /ready; do curl --fail --silent --show-error "$task_url$task_path" >/dev/null; done
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/unknown")" = 404 ]
for task_component in frontend backend; do
  task_image=$(compose_production images --quiet "$task_component")
  task_user=$(docker image inspect --format '{{.Config.User}}' "$task_image")
  case "$task_user" in ''|root|0|0:*) echo 'Runtime image must use a non-root user.' >&2; exit 1 ;; esac
  docker tag "$task_image" "else-$task_component:ci"
done
if [ -n "${IMAGE_ARCHIVE_PATH:-}" ]; then
  docker save --output "$IMAGE_ARCHIVE_PATH" else-frontend:ci else-backend:ci
fi
printf '%s\n' 'Compose development/runtime, TLS, permissions, migrations, recovery, and persistence verified.'
