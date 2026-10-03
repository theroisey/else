#!/bin/sh
# Sourced by the isolated Compose runner, whose compose() fixes project scope.
recover_compose_postgres() {
  # A health wait in `up` can observe the old exited state. Start the existing
  # container explicitly before probing it; never recreate its data volume.
  if ! compose start postgres >/dev/null 2>&1; then
    echo 'PostgreSQL recovery start failed.' >&2
    return 1
  fi
  task_database_attempt=0
  until compose exec -T postgres env PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000' \
    psql -X -U postgres -d else -v ON_ERROR_STOP=1 -Atc 'SELECT 1' >/dev/null 2>&1; do
    task_database_attempt=$((task_database_attempt + 1))
    if [ "$task_database_attempt" -ge 30 ]; then
      echo 'PostgreSQL readiness did not recover.' >&2
      return 1
    fi
    sleep 1
  done
}
