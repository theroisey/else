#!/bin/sh
set +x
set -eu
# psql imports credentials privately; no shell interpolation into SQL or arguments.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv migrator_password MIGRATOR_PASSWORD
\getenv runtime_password RUNTIME_PASSWORD
CREATE ROLE else_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migrator_password';
CREATE ROLE else_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'runtime_password';
ALTER DATABASE else OWNER TO else_migrator;
REVOKE ALL ON DATABASE else FROM PUBLIC;
GRANT CONNECT ON DATABASE else TO else_migrator, else_runtime;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO else_migrator;
SQL
