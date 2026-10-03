#!/bin/sh
# Compile immutable metadata; inputs are values, never shell fragments.
set +x
set -eu
fail() { echo 'Invalid API build metadata.' >&2; exit 1; }
[ "$#" -eq 4 ] || fail
task_output=$1
task_version=$2
task_revision=$3
task_built_at=$4
cd "$(dirname "$0")/.."
if [ -z "$task_version$task_revision$task_built_at" ]; then
  exec go build -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w' -o "$task_output" ./cmd/api
fi
[ "${#task_revision}" -eq 40 ] || fail
case "$task_revision" in *[!a-f0-9]*|0000000000000000000000000000000000000000) fail ;; esac
[ "$task_version" = "sha-$task_revision" ] || fail
[ "${#task_built_at}" -eq 20 ] || fail
case "$task_built_at" in ????-??-??T??:??:??Z) ;; *) fail ;; esac
task_canonical=$(date -u -d "$task_built_at" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null) || fail
[ "$task_canonical" = "$task_built_at" ] || fail
task_year=$(date -u -d "$task_built_at" '+%Y' 2>/dev/null) || fail
[ "$task_year" -ge 2000 ] || fail
task_package=github.com/theroisey/else/backend/internal/buildinfo
exec go build -mod=readonly -trimpath -buildvcs=false \
  -ldflags "-s -w -X $task_package.version=$task_version -X $task_package.revision=$task_revision -X $task_package.builtAt=$task_built_at" \
  -o "$task_output" ./cmd/api
