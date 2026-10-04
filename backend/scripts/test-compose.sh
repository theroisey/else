#!/bin/sh
# Isolated one-container installation and persistence verification, never customer resources.
set +x
set -eu
cd "$(dirname "$0")/../.."
task_revision=$(git rev-parse HEAD)
task_directory=$(mktemp -d)
task_project="else-ci-$(openssl rand -hex 6)"
task_initialized=false
task_restore_project="${task_project}-restore"
task_restore_volume="${task_restore_project}_data"
# Local candidate shortcuts cannot create publication artifacts or run in CI.
if [ -n "${ELSE_TEST_WORKTREE:-}${ELSE_TEST_IMAGE:-}" ]; then
  [ "${GITHUB_ACTIONS:-}" != true ] && [ -z "${IMAGE_ARCHIVE_PATH:-}" ] || {
    echo 'Local candidate options are forbidden during publication verification.' >&2; exit 1;
  }
fi
compose() {
  docker compose --project-name "$task_project" --project-directory "$task_directory" \
    --file "$task_directory/docker-compose.yml" --file "$task_directory/docker-compose.ci.yml" "$@"
}
restore_compose() {
  ELSE_DATA_VOLUME="$task_restore_volume" docker compose --project-name "$task_restore_project" --project-directory "$task_directory" \
    --file "$task_directory/docker-compose.yml" --file "$task_directory/docker-compose.ci.yml" "$@"
}
cleanup() {
  task_result=$?
  trap - EXIT INT TERM
  restore_compose down --volumes --remove-orphans >/dev/null 2>&1 || task_result=1
  if [ "$task_initialized" = true ]; then
    if [ "$task_result" -ne 0 ]; then compose logs --no-color --tail 100 >&2 || true; fi
    compose down --volumes --remove-orphans >/dev/null || task_result=1
  fi
  rm -rf "$task_directory"
  exit "$task_result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "${ELSE_TEST_WORKTREE:-}" = true ]; then
  (umask 022; git ls-files --cached --others --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C "$task_directory")
  echo 'Verifying a local worktree candidate; no publication artifact is permitted.'
else
  (umask 022; git archive HEAD | tar -x -C "$task_directory")
fi
cp "$task_directory/.env.example" "$task_directory/.env"
APP_PORT=0
ELSE_DATA_VOLUME="${task_project}_data"
CI_REVISION=$task_revision
CI_BUILD_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
CI_IMAGE_TAG=$task_project
export APP_PORT ELSE_DATA_VOLUME CI_REVISION CI_BUILD_TIME CI_IMAGE_TAG
. "$task_directory/backend/scripts/recover-compose.sh"
compose config --quiet
compose config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); assert list(c["services"])==["else"]; assert list(c["volumes"])==["else_data"]; assert len(c["services"]["else"]["ports"])==1; assert c["services"]["else"]["ports"][0]["target"]==8080'
if [ -n "${ELSE_TEST_IMAGE:-}" ]; then
  docker tag "$ELSE_TEST_IMAGE" "else-application:$CI_IMAGE_TAG"
  task_expected_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ELSE_TEST_IMAGE")
  task_expected_time=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.created"}}' "$ELSE_TEST_IMAGE")
  if [ "$task_expected_revision" = '<no value>' ]; then task_expected_revision=''; task_expected_time=''; fi
else
  if [ -n "${CODEX_PROXY_CERT:-}" ]; then compose --file "$task_directory/docker-compose.proxy.yml" build else; else compose build else; fi
  task_expected_revision=$CI_REVISION
  task_expected_time=$CI_BUILD_TIME
fi
task_initialized=true
compose up -d --wait --wait-timeout 180
task_container=$(compose ps --quiet else)
task_image=$(compose images --quiet else)
task_url="http://$(compose port else 8080)"
docker image inspect "$task_image" | python3 -c 'import json,sys; c=json.load(sys.stdin)[0]["Config"]; assert not c.get("Volumes"); assert list(c["ExposedPorts"])==["8080/tcp"]'
docker inspect "$task_container" | python3 -c 'import json,sys; c=json.load(sys.stdin)[0]; volumes=[m for m in c["Mounts"] if m["Type"]=="volume"]; assert len(volumes)==1 and volumes[0]["Destination"]=="/var/lib/roisey-else"; assert c["HostConfig"]["ReadonlyRootfs"]'
[ "$(docker inspect --format '{{.State.Health.Status}}' "$task_container")" = healthy ]
compose exec -T else sh -c '! command -v node; ! command -v npm; ! command -v go; command -v postgres >/dev/null; command -v tini >/dev/null'
# Separate service identities, root-private credentials, and private PGDATA.
compose exec -T --user 65532:65532 else sh -c 'test ! -r /var/lib/roisey-else/.control/database.credentials; test ! -r /var/lib/roisey-else/18/docker/PG_VERSION'
compose exec -T else sh -c 'test "$(ps -o uid= -C api | tr -d " ")" = 65532; test "$(ps -o uid= -C analytics-worker | tr -d " ")" = 65532; test "$(ps -o uid= -C postgres | sort -u | tr -d " ")" = 999'
compose exec -T else /opt/else/operator migrate status
runtime_query() { compose exec -T else /opt/else/operator runtime-psql -Atc "$1"; }
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
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.integration_rotation_candidates(uuid,uuid,text,bytea,uuid,integer)','EXECUTE')")" = t ]
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.integration_key_inventory(uuid,text[],bytea[],text,boolean)','EXECUTE')")" = t ]
for task_sql in 'SELECT * FROM app.analytics_sync_jobs' 'SELECT * FROM app.analytics_snapshots' 'UPDATE app.analytics_sync_jobs SET state=$$failed$$' 'DELETE FROM app.analytics_snapshots' 'TRUNCATE app.analytics_sync_jobs'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Report storage runtime privilege boundary failed.' >&2; exit 1; fi
done
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.provider_sync_claim(text)','EXECUTE') AND has_function_privilege(current_user,'app.commerce_sync_finish(uuid,uuid,jsonb)','EXECUTE') AND has_function_privilege(current_user,'app.commerce_workspace_read(uuid,uuid,uuid,timestamptz,timestamptz,text)','EXECUTE') AND NOT has_function_privilege(current_user,'app.provider_sync_finish(text,uuid,uuid,jsonb)','EXECUTE') AND NOT has_function_privilege(current_user,'app.commerce_workspace_valid(jsonb,uuid,uuid,timestamptz,timestamptz,text)','EXECUTE')")" = t ]
[ "$(runtime_query "SELECT has_function_privilege(current_user,'app.marketing_sync_finish(uuid,uuid,jsonb)','EXECUTE') AND has_function_privilege(current_user,'app.marketing_workspace_read(uuid,uuid,uuid,date,date)','EXECUTE') AND NOT has_function_privilege(current_user,'app.marketing_workspace_valid(jsonb,uuid,uuid,date,date)','EXECUTE') AND NOT has_function_privilege(current_user,'app.marketing_metrics_valid(jsonb,integer)','EXECUTE') AND NOT has_function_privilege(current_user,'app.marketing_ratio(numeric,numeric,numeric)','EXECUTE')")" = t ]
for task_sql in 'SELECT * FROM app.pricing_sheets' 'SELECT * FROM app.pricing_versions' 'SELECT * FROM app.pricing_lines' 'SELECT * FROM app.pricing_snapshots' 'SELECT * FROM app.pricing_snapshot_lines' 'UPDATE app.pricing_sheets SET revision=revision+1' 'DELETE FROM app.pricing_versions' 'TRUNCATE app.pricing_snapshots' 'SELECT app.pricing_calculate($${}$$::jsonb)' 'SELECT app.pricing_version_document(gen_random_uuid(),true)'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Pricing runtime privilege boundary failed.' >&2; exit 1; fi
done
for task_sql in 'SELECT * FROM app.collections' 'SELECT * FROM app.payments' 'SELECT * FROM app.billing_currencies' 'UPDATE app.collections SET paid_minor=1' 'DELETE FROM app.collections' 'TRUNCATE app.payments' 'SELECT app.billing_document(gen_random_uuid())' 'SELECT app.billing_snapshot(gen_random_uuid())'; do
  if runtime_query "$task_sql" >/dev/null 2>&1; then echo 'Finance runtime privilege boundary failed.' >&2; exit 1; fi
done
[ "$(runtime_query 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')" = f ]
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

for task_path in / /app /app/clients /status /health /ready; do curl --fail --silent --show-error "$task_url$task_path" >/dev/null; done
python3 "$task_directory/frontend/scripts/check-security-headers.py" "$task_url"
for task_path in /api/v1/unknown /assets/missing.js; do
  [ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url$task_path")" = 404 ]
done
for task_path in /api/v1/auth/session /api/v1/releases /api/v1/clients; do
  [ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$task_url$task_path")" = 401 ]
done
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --request POST --header 'Origin: https://invalid.example' --header 'Content-Type: application/json' --data '{"email":"nobody@example.com","password":"not-a-real-password"}' "$task_url/api/v1/auth/login")" = 403 ]
if docker run --rm --network none --user 65533:65533 --entrypoint /bootstrap-admin "$task_image" > "$task_directory/bootstrap.log" 2>&1; then
  echo 'Bootstrap accepted a noninteractive invocation.' >&2; exit 1
fi
python3 - "$task_directory/bootstrap.log" <<'PYTHON'
import json,pathlib,sys
report=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert report['msg']=='bootstrap_failed' and report['error_code']=='interactive_terminal_required'
assert set(report)=={'time','level','msg','error_code'}
PYTHON
python3 "$task_directory/backend/scripts/check-release-runtime.py" prepare "$task_directory/release-cookies.json" | \
  compose exec -T else /opt/else/operator psql >/dev/null
python3 "$task_directory/backend/scripts/check-release-runtime.py" verify "$task_directory/release-cookies.json" "$task_url" "$task_expected_revision" "$task_expected_time"
python3 "$task_directory/backend/scripts/check-container-client.py" create "$task_directory/client.json" "$task_directory/release-cookies.json" "$task_url"
verify_client() {
  task_url="http://$(compose port else 8080)"
  python3 "$task_directory/backend/scripts/check-container-client.py" verify "$task_directory/client.json" "$task_directory/release-cookies.json" "$task_url"
}
# Actual restart, clean stop, and replacement must preserve the same client/audit.
compose restart else >/dev/null
recover_compose_else
verify_client
compose stop else >/dev/null
[ "$(docker inspect --format '{{.State.ExitCode}}' "$task_container")" = 0 ]
compose logs --no-color | rg -q 'database system is shut down'
compose down >/dev/null
compose up -d --wait --wait-timeout 180
[ "$(compose ps --quiet else)" != "$task_container" ]
verify_client
# A different image reference recreates the service while retaining its volume.
task_before=$(compose ps --quiet else)
docker tag "$task_image" "else-application:${task_project}-replacement"
CI_IMAGE_TAG="${task_project}-replacement"
export CI_IMAGE_TAG
compose up -d --wait --wait-timeout 180
[ "$(compose ps --quiet else)" != "$task_before" ]
verify_client
# Adopt the former PostgreSQL 18 volume layout without our new control files.
# This fixture has no encrypted credentials; real encrypted installs retain keys.
compose stop else >/dev/null
compose run --rm --no-deps --entrypoint sh else -c 'rm -rf /var/lib/roisey-else/.control' >/dev/null
recover_compose_else
verify_client
[ "$(compose exec -T else /opt/else/operator psql -Atc 'SELECT count(*) FROM public.goose_db_version WHERE version_id > 0 AND is_applied')" = 25 ]
# A usable real custom archive is created with the protected local administrator.
compose exec -T else /opt/else/operator backup > "$task_directory/backup.dump"
compose exec -T else gosu postgres pg_restore --list < "$task_directory/backup.dump" > "$task_directory/backup.list"
rg -q 'TABLE DATA app clients' "$task_directory/backup.list"
rg -q 'TABLE DATA app audit_events' "$task_directory/backup.list"
# Required-child death must fail the complete container, then recover existing data.
task_container=$(compose ps --quiet else)
compose exec -T else sh -c 'kill -KILL "$(head -n 1 /var/lib/roisey-else/18/docker/postmaster.pid)"'
task_attempt=0
while [ "$(docker inspect --format '{{.State.Running}}' "$task_container")" = true ]; do
  task_attempt=$((task_attempt + 1)); [ "$task_attempt" -lt 60 ] || { echo 'Supervisor ignored database death.' >&2; exit 1; }; sleep 1
done
[ "$(docker inspect --format '{{.State.ExitCode}}' "$task_container")" != 0 ]
recover_compose_else
verify_client
# Migration failure prevents API/worker startup and shuts PostgreSQL down safely.
compose stop else >/dev/null
printf '#!/bin/sh\nprintf "synthetic-private-migration-error\\n" >&2\nexit 1\n' > "$task_directory/failing-migrate"
chmod 755 "$task_directory/failing-migrate"
if compose run --rm --no-deps --volume "$task_directory/failing-migrate:/migrate:ro" else > "$task_directory/migration-failure.log" 2>&1; then
  echo 'Failed migration incorrectly allowed startup.' >&2; exit 1
fi
rg -q mandatory_initialization_failed "$task_directory/migration-failure.log"
if rg -q 'starting_roisey_else|synthetic-private-migration-error' "$task_directory/migration-failure.log"; then
  echo 'Unsafe migration failure or private diagnostic leakage.' >&2; exit 1
fi
recover_compose_else
verify_client
# Concurrent owners of the same persistent cluster are rejected before PG starts.
if compose run --rm --no-deps else > "$task_directory/volume-lock.log" 2>&1; then
  echo 'Concurrent use of the database volume was accepted.' >&2; exit 1
fi
rg -q data_volume_in_use "$task_directory/volume-lock.log"
verify_client
# An API that fails immediately must bring down PG and the complete container.
compose stop else >/dev/null
if compose run --rm --no-deps --volume "$task_directory/failing-migrate:/api:ro" else > "$task_directory/api-failure.log" 2>&1; then
  echo 'Early API death was ignored.' >&2; exit 1
fi
rg -q supervised_process_exited "$task_directory/api-failure.log"
rg -q 'database system is shut down' "$task_directory/api-failure.log"
recover_compose_else
verify_client
# Protected-source and restore preflight use the actual bundled worker/database.
python3 "$task_directory/backend/scripts/key-startup-fixtures.py" "$task_directory/key-fixtures"
compose exec -T else mkdir -m 755 /run/integration-keys
(cd "$task_directory/key-fixtures" && tar -cf - .) | compose exec -T else tar -xf - -C /run/integration-keys
compose exec -T else sh -c 'chown 65532:65532 /run/integration-keys/*.json; chmod 0400 /run/integration-keys/protected.json /run/integration-keys/fresh.json /run/integration-keys/malformed.json; chmod 0444 /run/integration-keys/public.json'
compose exec -T -e INTEGRATION_KEYRING_FILE=/run/integration-keys/protected.json else /opt/else/operator worker-once >/dev/null
for task_key_file in public.json malformed.json symlink.json missing.json; do
  if compose exec -T -e "INTEGRATION_KEYRING_FILE=/run/integration-keys/$task_key_file" else /opt/else/operator worker-once > "$task_directory/key-startup.log" 2>&1; then
    echo 'Insecure key source was accepted.' >&2; exit 1
  fi
  python3 "$task_directory/backend/scripts/check-key-startup-output.py" "$task_directory/key-startup.log" analytics_worker_key_startup_failed
done
compose exec -T else /opt/else/operator psql < "$task_directory/key-fixtures/register.sql" >/dev/null
if compose exec -T -e INTEGRATION_KEYRING_FILE=/run/integration-keys/protected.json -e INTEGRATION_KEYRING_MODE=restored else /opt/else/operator worker-once > "$task_directory/key-startup.log" 2>&1; then
  echo 'Declared restore reused a registered active key.' >&2; exit 1
fi
python3 "$task_directory/backend/scripts/check-key-startup-output.py" "$task_directory/key-startup.log" analytics_worker_key_startup_failed
compose exec -T -e INTEGRATION_KEYRING_FILE=/run/integration-keys/fresh.json -e INTEGRATION_KEYRING_MODE=restored else /opt/else/operator worker-once >/dev/null
# Never silently initialize beside incompatible or incomplete retained data.
restore_compose run --rm --no-deps --entrypoint sh else -c 'mkdir -p /var/lib/roisey-else/17/docker; printf "17\n" > /var/lib/roisey-else/17/docker/PG_VERSION' >/dev/null
if restore_compose run --rm --no-deps else > "$task_directory/incompatible.log" 2>&1; then
  echo 'Different-major cluster was silently replaced.' >&2; exit 1
fi
rg -q incompatible_postgresql_cluster "$task_directory/incompatible.log"
[ "$(restore_compose run --rm --no-deps --entrypoint cat else /var/lib/roisey-else/17/docker/PG_VERSION)" = 17 ]
restore_compose down --volumes >/dev/null
restore_compose run --rm --no-deps --entrypoint sh else -c 'mkdir -p /var/lib/roisey-else/18/docker; printf "retain-me\n" > /var/lib/roisey-else/18/docker/partial-fixture' >/dev/null
if restore_compose run --rm --no-deps else > "$task_directory/incomplete.log" 2>&1; then
  echo 'Incomplete cluster was silently replaced.' >&2; exit 1
fi
rg -q nonempty_uninitialized_database "$task_directory/incomplete.log"
[ "$(restore_compose run --rm --no-deps --entrypoint cat else /var/lib/roisey-else/18/docker/partial-fixture)" = retain-me ]
restore_compose down --volumes >/dev/null
# Real offline logical restore: reject reused active key, block normal startup,
# then accept a fresh active key with retained decryptors before starting writers.
compose exec -T else /opt/else/operator backup > "$task_directory/restore.dump"
restore_compose run --rm --no-deps --entrypoint /opt/else/operator else install-keyring < "$task_directory/key-fixtures/protected.json" >/dev/null
if restore_compose run --rm --no-deps -e ELSE_RESTORE_CONFIRMED=true else restore < "$task_directory/restore.dump" > "$task_directory/restore-failure.log" 2>&1; then
  echo 'Restore reused registered active encryption material.' >&2; exit 1
fi
rg -q checking_retained_and_fresh_keys "$task_directory/restore-failure.log"
if rg -q starting_roisey_else "$task_directory/restore-failure.log"; then exit 1; fi
if restore_compose run --rm --no-deps else > "$task_directory/restore-blocked.log" 2>&1; then
  echo 'Unverified restored data was allowed to start writers.' >&2; exit 1
fi
rg -q incomplete_restore_requires_verification "$task_directory/restore-blocked.log"
restore_compose run --rm --no-deps --entrypoint /opt/else/operator else install-keyring < "$task_directory/key-fixtures/fresh.json" >/dev/null
restore_compose run --rm --no-deps -e ELSE_RESTORE_CONFIRMED=true else verify-restore > "$task_directory/restore-verified.log" 2>&1
rg -q verified_offline_restore_complete "$task_directory/restore-verified.log"
if rg -q starting_roisey_else "$task_directory/restore-verified.log"; then exit 1; fi
restore_compose up -d --wait --wait-timeout 180
python3 "$task_directory/backend/scripts/check-container-client.py" verify "$task_directory/client.json" "$task_directory/release-cookies.json" "http://$(restore_compose port else 8080)"
[ "$(restore_compose exec -T else /opt/else/operator psql -Atc "SELECT count(*) FROM app.integration_encryption_keys WHERE key_label='synthetic-container'")" = 1 ]
restore_compose down --volumes >/dev/null
# Rotation retains exact confirmation grammar and non-root execution.
if docker run --rm --network none --user 65532:65532 --entrypoint /rotate-integration-credentials "$task_image" > "$task_directory/rotation.log" 2>&1; then
  echo 'Rotation accepted missing authority/confirmation.' >&2; exit 1
fi
python3 "$task_directory/backend/scripts/check-rotation-command-output.py" "$task_directory/rotation.log" integration_rotation_invalid
if [ -n "${IMAGE_ARCHIVE_PATH:-}" ]; then
  docker tag "$task_image" else-application:ci
  docker save --output "$IMAGE_ARCHIVE_PATH" else-application:ci
fi
printf '%s\n' 'One-container initialization, automatic migration/grants, process/role isolation, routing, shutdown, restart/replacement persistence, backup, child failure, and key safeguards verified.'
