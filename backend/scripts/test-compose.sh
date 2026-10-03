#!/bin/sh
# Test only an isolated committed checkout, unique project, and disposable volume.
set +x
set -eu
cd "$(dirname "$0")/../.."
task_revision=$(git rev-parse HEAD)
task_directory=$(mktemp -d)
task_project="else-ci-$(openssl rand -hex 6)"
task_initialized=false
task_key_container=''
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
  if [ -n "$task_key_container" ]; then docker rm --force "$task_key_container" >/dev/null 2>&1 || task_result=1; fi
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
compose exec -T postgres psql -U postgres -d else < "$task_directory/backend/scripts/grant-runtime.sql" >/dev/null

runtime_query() {
  compose exec -T postgres sh -eu -c '
    export PGPASSWORD="$RUNTIME_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT=/opt/else/tls-input/ca.crt
    exec psql -h postgres -U else_runtime -d else -v ON_ERROR_STOP=1 -Atc "$1"
  ' sh "$1"
}
for task_sql in 'SELECT * FROM app.integration_connections' 'UPDATE app.integration_connections SET state=$$connected$$' 'DELETE FROM app.integration_connections' 'TRUNCATE app.integration_connections' 'SELECT app.integration_connection_ownership_guard()'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Integration runtime privilege boundary failed.' >&2; exit 1; fi
done
for task_sql in 'SELECT * FROM app.integration_encryption_keys' 'UPDATE app.integration_encryption_keys SET reservations=0' 'DELETE FROM app.integration_encryption_keys' 'TRUNCATE app.integration_encryption_keys' 'SELECT app.integration_encryption_history_guard()'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Encryption accounting runtime privilege boundary failed.' >&2; exit 1; fi
done
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.integration_encryption_reserve(uuid,uuid,uuid,text,bytea)','EXECUTE') AND has_function_privilege(current_user,'app.integration_encryption_binding(uuid,uuid,uuid)','EXECUTE') AND NOT has_function_privilege(current_user,'app.integration_encryption_history_guard()','EXECUTE')")" = t ]
for task_sql in 'SELECT * FROM app.integration_credentials' 'UPDATE app.integration_credentials SET revision=revision+1' 'DELETE FROM app.integration_credentials' 'TRUNCATE app.integration_credentials' 'SELECT app.integration_credential_guard()' 'SELECT app.integration_credential_envelope_valid(NULL,NULL)'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Credential runtime privilege boundary failed.' >&2; exit 1; fi
done
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.integration_credential_read(uuid,uuid,uuid)','EXECUTE') AND has_function_privilege(current_user,'app.integration_credential_write(uuid,uuid,uuid,bigint,bigint,bigint,text,bytea,bytea,boolean)','EXECUTE') AND NOT has_function_privilege(current_user,'app.integration_credential_guard()','EXECUTE') AND NOT has_function_privilege(current_user,'app.integration_credential_envelope_valid(bytea,text)','EXECUTE')")" = t ]
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.integration_connection_list(uuid,uuid,uuid,integer)','EXECUTE') AND has_function_privilege(current_user,'app.integration_connection_read(uuid,uuid,uuid)','EXECUTE')")" = t ]
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.integration_local_disconnect(uuid,uuid,uuid,bigint)','EXECUTE')")" = t ]
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.integration_key_preflight(text[],bytea[],text,boolean)','EXECUTE')")" = t ]
for task_sql in 'SELECT * FROM app.pricing_sheets' 'SELECT * FROM app.pricing_versions' 'SELECT * FROM app.pricing_lines' 'SELECT * FROM app.pricing_snapshots' 'SELECT * FROM app.pricing_snapshot_lines' 'UPDATE app.pricing_sheets SET revision=revision+1' 'DELETE FROM app.pricing_versions' 'TRUNCATE app.pricing_snapshots' 'SELECT app.pricing_calculate($${}$$::jsonb)' 'SELECT app.pricing_version_document(gen_random_uuid(),true)'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Pricing runtime privilege boundary failed.' >&2; exit 1; fi
done
for task_sql in 'SELECT * FROM app.collections' 'SELECT * FROM app.payments' 'SELECT * FROM app.billing_currencies' 'UPDATE app.collections SET paid_minor=1' 'DELETE FROM app.collections' 'TRUNCATE app.payments' 'SELECT app.billing_document(gen_random_uuid())' 'SELECT app.billing_snapshot(gen_random_uuid())'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Finance runtime privilege boundary failed.' >&2; exit 1; fi
done
[ "$(runtime_query 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')" = t ]
[ "$(runtime_query "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname = current_user")" = f ]
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.client_overview(uuid,uuid)','EXECUTE')")" = t ]
for task_sql in 'CREATE SCHEMA forbidden_ci' 'CREATE TABLE public.forbidden_ci (id integer)' 'SELECT * FROM public.goose_db_version' 'SELECT * FROM app.audit_events' 'UPDATE app.audit_events SET event_name=$$fixture.updated$$' 'DELETE FROM app.audit_events' 'TRUNCATE app.audit_events' 'ALTER TABLE app.audit_events DISABLE TRIGGER audit_history_append_only'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Runtime privilege boundary failed.' >&2; exit 1; fi
done
for task_sql in 'SELECT email FROM app.users' 'SELECT password_hash FROM app.users' 'SELECT token_hash FROM app.sessions' 'SELECT bootstrap_admin FROM app.users' 'UPDATE app.users SET bootstrap_admin=true' 'UPDATE app.users SET password_hash=$$secret$$' 'DELETE FROM app.users' 'DELETE FROM app.sessions' 'TRUNCATE app.users CASCADE'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Identity runtime privilege boundary failed.' >&2; exit 1; fi
done
for task_sql in 'SELECT * FROM app.permissions' 'SELECT * FROM app.roles' 'SELECT * FROM app.role_permissions' 'SELECT * FROM app.user_roles' 'INSERT INTO app.user_roles (id,user_id,role_id,scope_kind) VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$$global$$)' 'UPDATE app.user_roles SET revoked_at=now()' 'DELETE FROM app.user_roles' 'TRUNCATE app.user_roles'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Authorization runtime privilege boundary failed.' >&2; exit 1; fi
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
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/auth/session")" = 401 ]
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/clients/00000000-0000-4000-8000-000000000001/overview")" = 401 ]
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/clients/00000000-0000-4000-8000-000000000001/integrations")" = 401 ]
[ "$(curl --silent --request POST --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/clients/00000000-0000-4000-8000-000000000001/integrations/00000000-0000-4000-8000-000000000002/disconnect")" = 401 ]
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --request POST --header 'Origin: https://invalid.example' --header 'Content-Type: application/json' --data '{"email":"nobody@example.com","password":"not-a-real-password"}' "$task_url/api/v1/auth/login")" = 403 ]
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
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/auth/session")" = 401 ]
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/clients/00000000-0000-4000-8000-000000000001/overview")" = 401 ]
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/clients/00000000-0000-4000-8000-000000000001/integrations")" = 401 ]
[ "$(curl --silent --request POST --output /dev/null --write-out '%{http_code}' "$task_url/api/v1/clients/00000000-0000-4000-8000-000000000001/integrations/00000000-0000-4000-8000-000000000002/disconnect")" = 401 ]
for task_component in frontend backend; do
  task_image=$(compose_production images --quiet "$task_component")
  task_user=$(docker image inspect --format '{{.Config.User}}' "$task_image")
  case "$task_user" in ''|root|0|0:*) echo 'Runtime image must use a non-root user.' >&2; exit 1 ;; esac
  docker tag "$task_image" "else-$task_component:ci"
done

# Verify actual non-root runtime startup against protected transient synthetic
# mounts. Helpers use the already-tested PostgreSQL image with no networking.
python3 "$task_directory/backend/scripts/key-startup-fixtures.py" "$task_directory/key-fixtures"
task_postgres_image=$(compose images --quiet postgres)
docker run --rm --network none --volume "$task_directory/key-fixtures:/fixtures" --entrypoint sh "$task_postgres_image" -eu -c '
  chown 65532:65532 /fixtures/protected.json /fixtures/public.json /fixtures/malformed.json /fixtures/fresh.json
  chmod 0400 /fixtures/protected.json /fixtures/malformed.json /fixtures/fresh.json
  chmod 0444 /fixtures/public.json
' >/dev/null
task_key_container="$task_project-key-startup"
compose_production run --detach --no-deps --name "$task_key_container" \
  --volume "$task_directory/key-fixtures:/run/integration-keys:ro" \
  --env INTEGRATION_KEYRING_FILE=/run/integration-keys/protected.json backend >/dev/null
task_attempt=0
until docker exec "$task_key_container" /healthcheck >/dev/null 2>&1; do
  task_attempt=$((task_attempt + 1))
  [ "$task_attempt" -lt 30 ] || { echo 'Protected integration key startup did not become ready.' >&2; exit 1; }
  sleep 1
done
docker rm --force "$task_key_container" >/dev/null
task_key_container=''
[ "$(runtime_query 'SELECT count(*) FROM app.integration_encryption_keys')" = 0 ]
for task_key_file in public.json malformed.json symlink.json missing.json; do
  if compose_production run --rm --no-deps \
    --volume "$task_directory/key-fixtures:/run/integration-keys:ro" \
    --env "INTEGRATION_KEYRING_FILE=/run/integration-keys/$task_key_file" backend \
    > "$task_directory/key-startup.log" 2>&1; then
    echo 'Insecure integration key source started successfully.' >&2; exit 1
  fi
  python3 "$task_directory/backend/scripts/check-key-startup-output.py" "$task_directory/key-startup.log"
done
compose exec -T postgres psql -U postgres -d else -v ON_ERROR_STOP=1 < "$task_directory/key-fixtures/register.sql" >/dev/null
if compose_production run --rm --no-deps \
  --volume "$task_directory/key-fixtures:/run/integration-keys:ro" \
  --env INTEGRATION_KEYRING_FILE=/run/integration-keys/protected.json \
  --env INTEGRATION_KEYRING_MODE=restored backend > "$task_directory/key-startup.log" 2>&1; then
  echo 'Declared restore reused a registered active key.' >&2; exit 1
fi
python3 "$task_directory/backend/scripts/check-key-startup-output.py" "$task_directory/key-startup.log"
task_key_container="$task_project-key-startup"
compose_production run --detach --no-deps --name "$task_key_container" \
  --volume "$task_directory/key-fixtures:/run/integration-keys:ro" \
  --env INTEGRATION_KEYRING_FILE=/run/integration-keys/fresh.json \
  --env INTEGRATION_KEYRING_MODE=restored backend >/dev/null
task_attempt=0
until docker exec "$task_key_container" /healthcheck >/dev/null 2>&1; do
  task_attempt=$((task_attempt + 1))
  [ "$task_attempt" -lt 30 ] || { echo 'Fresh declared-restore integration key startup did not become ready.' >&2; exit 1; }
  sleep 1
done
docker rm --force "$task_key_container" >/dev/null
task_key_container=''
[ "$(runtime_query 'SELECT count(*) FROM app.integration_encryption_keys')" = 1 ]
printf '%s\n' 'Protected integration key startup, fixed failures, and declared restore freshness verified.'
if [ -n "${IMAGE_ARCHIVE_PATH:-}" ]; then
  docker save --output "$IMAGE_ARCHIVE_PATH" else-frontend:ci else-backend:ci
fi
printf '%s\n' 'Compose development/runtime, TLS, permissions, migrations, recovery, and persistence verified.'
