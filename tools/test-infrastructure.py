#!/usr/bin/env python3
"""Own and remove only disposable test containers; never use production DB settings."""
import argparse
import gzip
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
REDIS = "redis:8.2.3-alpine@sha256:08ad0b1d280850169a790dba1393ff7a90aef951fc19632cf4d3ce4f78e679ba"
POSTGRES = "postgres:18.3@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db"


def docker(*args, **kwargs):
    return subprocess.run([os.environ.get("DOCKER", "docker"), *args], check=True, **kwargs)


def run(mode):
    name = "else-compat-test-" + uuid.uuid4().hex
    created = False
    try:
        if mode == "cache":
            docker("run", "--detach", "--name", name, "--label", "roisey.else.test=cache", "--publish", "127.0.0.1::6379", REDIS,
                   "redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "32mb", "--maxmemory-policy", "allkeys-lru", stdout=subprocess.DEVNULL)
        else:
            docker("run", "--detach", "--name", name, "--label", "roisey.else.test=import", "--network", "none",
                   "--tmpfs", "/var/lib/postgresql", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=postgres", POSTGRES,
                   "-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=/tmp,/var/run/postgresql", "-c", "timezone=Europe/Istanbul", stdout=subprocess.DEVNULL)
        created = True
        deadline = time.monotonic() + 60
        while True:
            command = ["redis-cli", "ping"] if mode == "cache" else ["pg_isready", "-U", "postgres", "-d", "postgres"]
            result = subprocess.run([os.environ.get("DOCKER", "docker"), "exec", name, *command], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            final_process = mode == "cache" or subprocess.run(
                [os.environ.get("DOCKER", "docker"), "exec", name, "cat", "/proc/1/comm"],
                capture_output=True, text=True).stdout.strip() == "postgres"
            if result.returncode == 0 and final_process:
                break
            if time.monotonic() > deadline:
                raise SystemExit("Disposable compatibility service did not become ready.")
            time.sleep(0.1)
        env = os.environ.copy()
        if mode == "cache":
            port = docker("port", name, "6379/tcp", capture_output=True, text=True).stdout.strip().rsplit(":", 1)[1]
            env["ELSE_TEST_REDIS_URL"] = f"redis://127.0.0.1:{port}/0"
            test = "redis_reports_are_versioned_authenticated_and_optional_under_failure"
        else:
            sql = gzip.decompress((ROOT / "backend/tests/fixtures/postgres-v28.sql.gz").read_bytes())
            docker("exec", "-i", name, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", input=sql, stdout=subprocess.DEVNULL)
            env["ELSE_TEST_POSTGRES_CONTAINER"] = name
            test = "actual_postgresql_export_import_retains_guarded_domain_records"
        subprocess.run([os.environ.get("CARGO", "cargo"), "test", "--locked", "--workspace", test, "--", "--ignored"], cwd=ROOT, env=env, check=True)
    finally:
        if created:
            docker("rm", "--force", name, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["cache", "import"])
    run(parser.parse_args().mode)
