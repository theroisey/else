#!/bin/sh
# The official entrypoint drops to postgres after preparing the data directory.
set -eu
install -d -m 700 -o postgres -g postgres /var/lib/postgresql/else-tls
install -m 600 -o postgres -g postgres /opt/else/tls-input/server.key /var/lib/postgresql/else-tls/server.key
install -m 644 -o postgres -g postgres /opt/else/tls-input/server.crt /var/lib/postgresql/else-tls/server.crt
exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/var/lib/postgresql/else-tls/server.crt \
  -c ssl_key_file=/var/lib/postgresql/else-tls/server.key \
  -c timezone=UTC
