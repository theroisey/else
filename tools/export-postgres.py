#!/usr/bin/env python3
"""One-time export from an isolated, stopped-application PostgreSQL volume clone.

Requires Docker and the official PostgreSQL image, never the new app runtime.
Keep the original volume untouched. All stdout diagnostics are fixed safe codes.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "backend/migrations/postgres-source-schema.json").read_text())
ORDER = ["users", "sessions", "permissions", "roles", "role_permissions", "client_scopes", "user_roles", "audit_events", "clients", "client_contacts", "client_tags", "tasks", "task_tags", "plans", "milestones", "milestone_task_links", "reminders", "billing_currencies", "collections", "payments", "pricing_sheets", "pricing_versions", "pricing_lines", "pricing_snapshots", "pricing_snapshot_lines", "integration_connections", "integration_encryption_keys", "integration_credentials", "analytics_sync_jobs", "analytics_snapshots", "client_websites", "website_integrations", "user_locale_preferences"]

class ExportRefusal(Exception):
    pass

def fail(code):
    raise ExportRefusal(code)

def private_read(path, maximum):
    if not path.is_absolute() or ".." in path.parts:
        fail("invalid_operator_path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) not in (0o400, 0o600) or before.st_uid not in (0, os.geteuid()) or before.st_size > maximum:
            fail("private_key_source_required")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mode, s.st_uid, s.st_nlink, s.st_mtime_ns, s.st_ctime_ns)
        if len(raw) > maximum or identity(before) != identity(after):
            fail("private_key_source_changed")
        return raw

def sql():
    counts = ",".join(f"'{name}',(SELECT count(*) FROM app.{name})" for name in ORDER)
    schema = "(SELECT jsonb_agg(jsonb_build_object('table',table_name,'columns',columns) ORDER BY table_name) FROM (SELECT table_name,jsonb_agg(jsonb_build_object('name',column_name,'type',udt_name,'nullable',is_nullable='YES') ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='app' GROUP BY table_name) s)"
    commands = ["BEGIN ISOLATION LEVEL REPEATABLE READ;", "SET LOCAL timezone='UTC';", "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='120s';", "LOCK TABLE " + ",".join("app." + table for table in ORDER) + " IN SHARE MODE;", f"SELECT jsonb_build_object('kind','header','format',1,'source','postgresql','version',(SELECT max(version_id) FROM public.goose_db_version WHERE is_applied),'schema',{schema},'counts',jsonb_build_object({counts}));"]
    catalog = {table["table"]: table for table in SCHEMA}
    for name in ORDER:
        fields = []
        for column in catalog[name]["columns"]:
            key, kind = column["name"], column["type"]
            if not re.fullmatch(r"[a-z_]+", key):
                fail("unsupported_source_schema")
            value = '"' + key + '"'
            if kind == "timestamptz":
                value = f"to_char({value} AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"
            elif kind in ("xid8", "date"):
                value += "::text"
            elif kind == "bytea":
                value = f"encode({value},'hex')"
            fields.extend(["'" + key + "'", value])
        commands.append(f"SELECT jsonb_build_object('kind','row','table','{name}','row',jsonb_build_object({','.join(fields)})) FROM app.{name};")
    commands.append(f"SELECT jsonb_build_object('kind','complete','counts',jsonb_build_object({counts}));")
    commands.append("COMMIT;")
    return "\n".join(commands)

def export(args):
    if not args.confirmed_offline or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.container):
        fail("isolated_offline_clone_required")
    destination = args.output
    if not destination.is_absolute() or ".." in destination.parts or destination.exists():
        fail("empty_absolute_export_destination_required")
    inspected = subprocess.run(["docker", "inspect", args.container], capture_output=True, timeout=10)
    if inspected.returncode:
        fail("offline_postgres_container_unavailable")
    info = json.loads(inspected.stdout)[0]
    primary = subprocess.run(["docker", "exec", "--user", "postgres", args.container, "cat", "/proc/1/comm"], capture_output=True, timeout=10)
    if not info["State"]["Running"] or primary.returncode or primary.stdout.strip() != b"postgres" or info["HostConfig"].get("PortBindings"):
        fail("isolated_offline_clone_required")
    key = private_read(args.key_file, 8192)
    # Full cryptographic/key-source validation happens in the Rust importer.
    if not key:
        fail("private_key_source_required")
    parent = destination.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = parent.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) & 0o077:
        fail("private_export_directory_required")
    pending = Path(tempfile.mkdtemp(prefix=".export-", dir=parent))
    try:
        data = pending / "postgres.jsonl"
        with data.open("xb") as output, tempfile.TemporaryFile(dir=pending) as diagnostics:
            os.chmod(data, 0o600)
            command = ["docker", "exec", "--user", "postgres", "-i", args.container, "psql", "-X", "-q", "-A", "-t", "--host", "/tmp", "--username", "postgres", "--dbname", args.database, "--set", "ON_ERROR_STOP=1", "--file", "-"]
            result = subprocess.run(command, input=sql().encode(), stdout=output, stderr=diagnostics, timeout=180)
            if result.returncode:
                fail("source_export_failed")
            output.flush()
            os.fsync(output.fileno())
        digest = hashlib.sha256()
        with data.open("rb") as source:
            header = json.loads(source.readline(262_145))
            if header.get("version") != 28 or header.get("schema") != SCHEMA:
                fail("unsupported_source_schema")
            source.seek(0)
            while chunk := source.read(65_536):
                digest.update(chunk)
        manifest = {"format": 1, "source": "postgresql", "version": 28, "exported_at": datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z"), "source_sha256": digest.hexdigest(), "keyring_sha256": hashlib.sha256(key).hexdigest()}
        for name, raw, mode in [("keyring.json", key, 0o400), ("manifest.json", json.dumps(manifest, separators=(",", ":")).encode(), 0o600)]:
            fd = os.open(pending / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            with os.fdopen(fd, "wb") as output:
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
        for directory in (pending, parent):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            os.fsync(fd)
            os.close(fd)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(-100, os.fsencode(pending), -100, os.fsencode(destination), 1):
            fail("export_destination_unavailable")
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        os.fsync(fd)
        os.close(fd)
        print("PostgreSQL export and retained key source captured; verify with the Rust importer.")
    finally:
        if pending.exists():
            shutil.rmtree(pending)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--database", default="else", choices=("else", "postgres"))
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--confirmed-offline", action="store_true")
    try:
        export(parser.parse_args())
    except ExportRefusal as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print("PostgreSQL export refused or incomplete; original storage is unchanged.", file=sys.stderr)
        sys.exit(1)
