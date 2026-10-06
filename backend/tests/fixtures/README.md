# PostgreSQL compatibility oracle

`postgres-v28.sql.gz` contains the exact original PostgreSQL migrations through
version 28, concatenated in order (Goose Up sections only), followed by the version
receipt. It is a test-only, compressed historical schema, not a second runtime or
an installation path. `make test-import` loads it into a disposable official
PostgreSQL container without published ports. The populated import test exercises
its original relational and financial guards; it never disables those guards.

Keep this oracle when changing the importer. Its corresponding fixed source
column/type catalog is `backend/migrations/postgres-source-schema.json`.
Production images contain neither fixture nor PostgreSQL tooling.
