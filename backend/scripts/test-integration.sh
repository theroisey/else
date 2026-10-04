#!/bin/sh
# Create only disposable PostgreSQL resources; never consume an external database URL.
set +x
set -eu
cd "$(dirname "$0")/.."
command -v go >/dev/null
command -v docker >/dev/null
command -v openssl >/dev/null
task_directory=$(mktemp -d)
task_container=""
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ -n "$task_container" ]; then
    docker rm --force "$task_container" >/dev/null || result=1
  fi
  rm -f "$task_directory/postgres.env"
  rmdir "$task_directory" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$task_directory"
task_password=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\n' "$task_password" > "$task_directory/postgres.env"
chmod 600 "$task_directory/postgres.env"
task_container=$(docker run --detach --rm --env-file "$task_directory/postgres.env" \
  --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql \
  postgres:18.3@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db \
  -c timezone=Europe/Istanbul)
attempt=0
until docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { printf '%s\n' 'Disposable PostgreSQL did not become ready.' >&2; exit 1; }
  sleep 1
done
task_port=$(docker port "$task_container" 5432/tcp | awk -F: '{print $NF}')
TEST_DATABASE_URL="postgres://postgres:$task_password@127.0.0.1:$task_port/postgres?sslmode=disable"
export TEST_DATABASE_URL
# Matching server-owned client tools are required for the logical recovery test.
TEST_POSTGRES_CONTAINER=$task_container
export TEST_POSTGRES_CONTAINER
unset PGSERVICE
# The complete real-database suite includes three provider lifecycles, capacity,
# cancellation and archive/restore rehearsals. Bound the whole suite explicitly;
# individual fixture/request/query/performance budgets remain unchanged.
go test -race -tags integration -timeout 15m -count=1 -v ./tests/integration "$@"
