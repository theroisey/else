#!/usr/bin/env bash
# Promote the single tested application image; never rebuild or expose authentication tokens.
set +x
set -euo pipefail
[[ ${GITHUB_REF:-} == refs/heads/main ]] || { echo 'Publication requires main.' >&2; exit 1; }
case ${GITHUB_EVENT_NAME:-} in
  push|workflow_dispatch) ;;
  *) echo 'Publication event is not authorized.' >&2; exit 1 ;;
esac
[[ ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid revision.' >&2; exit 1; }
[[ ${GITHUB_REPOSITORY:-} =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid repository.' >&2; exit 1; }
task_version=${IMAGE_VERSION:-}
if [[ -n $task_version && ! $task_version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Version must be stable vMAJOR.MINOR.PATCH without leading zeros.' >&2
  exit 1
fi
task_repository=${GITHUB_REPOSITORY,,}
if [[ ${1:-} == --print-tags && $# == 1 ]]; then
  printf 'ghcr.io/%s:sha-%s\n' "$task_repository" "$GITHUB_SHA"
  printf 'ghcr.io/%s:latest\n' "$task_repository"
  if [[ -n $task_version ]]; then printf 'ghcr.io/%s:%s\n' "$task_repository" "$task_version"; fi
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unsupported publication argument.' >&2; exit 1; }

# Do not overwrite immutable SHA/version aliases. Serialize publication in CI.
task_image="ghcr.io/$task_repository"
task_sha_ref="$task_image:sha-$GITHUB_SHA"
task_source="else-application:ci"
if docker manifest inspect "$task_sha_ref" >/dev/null 2>&1; then
  docker pull "$task_sha_ref"
  task_source=$task_sha_ref
fi
task_tested_id=$(docker image inspect --format '{{.Id}}' else-application:ci)
task_source_id=$(docker image inspect --format '{{.Id}}' "$task_source")
[[ $task_tested_id == "$task_source_id" && $task_tested_id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Published image differs from the tested image.' >&2; exit 1; }
task_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$task_source")
[[ $task_revision == "$GITHUB_SHA" ]] || { echo 'Image revision does not match the tested commit.' >&2; exit 1; }
if [[ $task_source != "$task_sha_ref" ]]; then
  docker tag "$task_source" "$task_sha_ref"
  docker push "$task_sha_ref"
fi
if [[ -n $task_version ]]; then
  task_version_ref="$task_image:$task_version"
  if docker manifest inspect "$task_version_ref" >/dev/null 2>&1; then
    docker pull "$task_version_ref"
    task_alias_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$task_version_ref")
    [[ $task_alias_revision == "$GITHUB_SHA" ]] || { echo 'Version alias already belongs to another revision.' >&2; exit 1; }
    task_alias_id=$(docker image inspect --format '{{.Id}}' "$task_version_ref")
    [[ $task_alias_id == "$task_tested_id" ]] || { echo 'Version alias differs from the tested image.' >&2; exit 1; }
  else
    docker tag "$task_source" "$task_version_ref"
    docker push "$task_version_ref"
  fi
fi
task_main_sha=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)
if [[ $task_main_sha == "$GITHUB_SHA" ]]; then
  docker tag "$task_source" "$task_image:latest"
  docker push "$task_image:latest"
else
  echo 'Main advanced; retaining its latest alias.'
fi

# Resolve the pushed digest from Docker's registry-owned RepoDigests; never
# rebuild an image for attestation. The helper emits only validated public data.
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  docker image inspect --format '{{json .RepoDigests}}' "$task_sha_ref" |
    python3 "$(dirname "$0")/published-image-output.py" "$task_image" "$GITHUB_OUTPUT"
fi
