#!/bin/sh
# Creates only isolated test infrastructure. Never consumes an external DB URL.
set +x
set -eu
cd "$(dirname "$0")/../.."
task_directory=$(mktemp -d)
task_revision=$(git rev-parse HEAD)
task_build_time=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
task_container=""
task_api_pid=""
task_frontend_pid=""
docker_local() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
cleanup() {
  task_result=$?
  trap - EXIT INT TERM
  if [ -n "$task_frontend_pid" ]; then kill "$task_frontend_pid" 2>/dev/null || true; wait "$task_frontend_pid" 2>/dev/null || true; fi
  if [ -n "$task_api_pid" ]; then kill "$task_api_pid" 2>/dev/null || true; wait "$task_api_pid" 2>/dev/null || true; fi
  if [ -n "$task_container" ]; then docker_local rm --force "$task_container" >/dev/null || task_result=1; fi
  rm -rf "$task_directory"
  exit "$task_result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$task_directory"
# Refuse occupied app ports so this test cannot attach to a developer's server.
node --input-type=module <<'JS'
import { createServer } from 'node:net';
for (const port of [8080, 5173]) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('Browser-test ports must be available.')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
JS
task_password=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=else\n' "$task_password" > "$task_directory/postgres.env"
chmod 600 "$task_directory/postgres.env"
task_container=$(docker_local run --detach --rm --env-file "$task_directory/postgres.env" \
  --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql --label roisey.else.test=browser-auth \
  postgres:18.3@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db)
task_attempt=0
until docker_local exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; do
  task_attempt=$((task_attempt + 1))
  [ "$task_attempt" -lt 30 ] || { echo 'Isolated browser database did not become ready.' >&2; exit 1; }
  sleep 1
done
task_port=$(docker_local port "$task_container" 5432/tcp | awk -F: '{print $NF}')
(
  cd backend
  sh scripts/build-api.sh "$task_directory/api" "sha-$task_revision" "$task_revision" "$task_build_time"
  go build -mod=readonly -trimpath -o "$task_directory/migrate" ./cmd/migrate
)
unset PGSERVICE
MIGRATION_DATABASE_URL="postgres://postgres:$task_password@127.0.0.1:$task_port/else?sslmode=disable" "$task_directory/migrate" up
printf "CREATE ROLE else_runtime LOGIN PASSWORD '%s';\n" "$task_password" | docker_local exec -i "$task_container" psql -U postgres -d else -v ON_ERROR_STOP=1 >/dev/null
docker_local exec -i "$task_container" psql -U postgres -d else < backend/scripts/grant-runtime.sql >/dev/null
docker_local exec -i "$task_container" psql -U postgres -d else -v ON_ERROR_STOP=1 < frontend/e2e/fixtures.sql >/dev/null
DATABASE_URL="postgres://else_runtime:$task_password@127.0.0.1:$task_port/else?sslmode=disable" \
  AUTH_PUBLIC_ORIGIN=http://127.0.0.1:5173 AUTH_COOKIE_SECURE=false HTTP_ADDRESS=127.0.0.1:8080 \
  "$task_directory/api" > "$task_directory/api.log" 2>&1 &
task_api_pid=$!
# Built artifact compatibility uses exactly the compiled Go runtime header policy.
# Public/failed-login probes do not add successful-session audit fixture rows.
(cd frontend && npm run build)
(
  cd frontend
  exec node node_modules/vite/bin/vite.js preview --config vite.security.config.ts --host 127.0.0.1 --port 5173 --strictPort
) > "$task_directory/preview.log" 2>&1 &
task_frontend_pid=$!
task_attempt=0
until curl --fail --silent http://127.0.0.1:5173/ready >/dev/null; do
  task_attempt=$((task_attempt + 1))
  [ "$task_attempt" -lt 30 ] || { echo 'Security artifact preview did not become ready.' >&2; exit 1; }
  sleep 1
done
node frontend/scripts/check-runtime-security.mjs http://127.0.0.1:5173
# Retain all original cookie/audit flows against the same secured artifact.
cd frontend
AUTH_TEST_CONTAINER=$task_container AUTH_TEST_REVISION=$task_revision AUTH_TEST_BUILD_TIME=$task_build_time npm run test:e2e
