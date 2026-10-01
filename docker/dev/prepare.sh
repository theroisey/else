#!/bin/sh
# Generate only local development material; never overwrite existing credentials.
set +x
set -eu
cd "$(dirname "$0")/../.."
command -v openssl >/dev/null
[ ! -e .env ] && [ ! -e docker/dev/tls ] || {
  printf '%s\n' 'Existing .env or TLS directory found; keep it with its database volume.' >&2
  exit 1
}
umask 077
task_directory=$(mktemp -d docker/dev/.prepare.XXXXXX)
trap 'rm -rf "$task_directory"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$task_directory/tls"
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 \
  -subj /CN=Else-Local-Development-CA \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$task_directory/ca.key" -out "$task_directory/tls/ca.crt" 2>/dev/null
openssl req -new -newkey rsa:3072 -nodes -sha256 -subj /CN=postgres \
  -keyout "$task_directory/tls/server.key" -out "$task_directory/server.csr" 2>/dev/null
cat > "$task_directory/server.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:postgres
EXT
openssl x509 -req -sha256 -days 365 -in "$task_directory/server.csr" \
  -CA "$task_directory/tls/ca.crt" -CAkey "$task_directory/ca.key" -CAcreateserial \
  -extfile "$task_directory/server.ext" -out "$task_directory/tls/server.crt" 2>/dev/null
{
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'MIGRATOR_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'RUNTIME_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'FRONTEND_PORT=5173\n'
} > "$task_directory/env"
# Public certificates must be readable by non-root backend and postgres probes.
chmod 755 "$task_directory/tls"
chmod 644 "$task_directory/tls/ca.crt" "$task_directory/tls/server.crt"
mv "$task_directory/tls" docker/dev/tls
mv "$task_directory/env" .env
printf '%s\n' 'Local credentials and TLS generated. Follow docs/docker.md to start and migrate.'
