#!/bin/sh
# Sourced by the isolated runner; compose() fixes the unique project/volume scope.
recover_compose_else() {
  if ! compose start else >/dev/null 2>&1; then
    echo 'Application recovery start failed.' >&2
    return 1
  fi
  task_application_attempt=0
  until compose exec -T else /healthcheck >/dev/null 2>&1; do
    task_application_attempt=$((task_application_attempt + 1))
    if [ "$task_application_attempt" -ge 60 ]; then
      echo 'Application readiness did not recover.' >&2
      return 1
    fi
    sleep 1
  done
}
