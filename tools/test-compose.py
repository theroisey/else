#!/usr/bin/env python3
"""Test the production Compose file using internal, isolated fixture overrides."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import runtime_fixture

ROOT = Path(__file__).resolve().parent.parent
DATA = "/var/lib/roisey-else"


def main(image, evidence):
    identity = "else-compose-test-" + uuid.uuid4().hex
    recovered = identity + "-restored"
    environment = {key: value for key, value in os.environ.items() if not key.startswith("COMPOSE_")}
    with socket.socket() as selected:
        selected.bind(("127.0.0.1", 0))
        port = selected.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    environment.update(APP_PORT=str(port), AUTH_PUBLIC_ORIGIN=origin, AUTH_COOKIE_SECURE="false")
    docker = os.environ.get("DOCKER", "docker")
    created = False
    with tempfile.TemporaryDirectory(prefix=identity) as temporary:
        env_file = Path(temporary) / "empty.env"
        env_file.write_text("")
        override = Path(temporary) / "fixture.json"
        base = [docker, "compose", "--env-file", str(env_file), "--file", str(ROOT / "docker-compose.yml"), "--project-name", identity]
        command = [*base, "--file", str(override)]

        def isolated(volume, container):
            # Fixture-only names/image; the production file has no selection knobs.
            override.write_text(json.dumps({"services": {"else": {"image": image, "container_name": container}}, "volumes": {"else_data": {"name": volume}}}))

        def compose(*arguments, **kwargs):
            return subprocess.run([*command, *arguments], cwd=ROOT, env=environment, check=True, **kwargs)

        def workflow(target, *variables, **kwargs):
            return subprocess.run(["make", "COMPOSE=" + shlex.join(command), target, *variables], cwd=ROOT, env=environment, check=True, **kwargs)

        cookies = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies), urllib.request.ProxyHandler({}))

        def request(path, payload=None, expected=200):
            headers = {}
            body = None
            if payload is not None:
                body = json.dumps(payload).encode()
                headers = {"Origin": origin, "Content-Type": "application/json"}
                csrf = next((cookie.value for cookie in cookies if cookie.name == "else_csrf"), None)
                if csrf:
                    headers["X-CSRF-Token"] = csrf
            try:
                response = opener.open(urllib.request.Request(origin + path, body, headers), timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                assert response.status == expected, f"Compose {path}: {response.status}"
                raw = response.read()
                return json.loads(raw) if response.headers.get("Content-Type", "").startswith("application/json") else raw

        def details():
            return json.loads(subprocess.run([docker, "inspect", identity], check=True, capture_output=True, text=True).stdout)[0]

        def healthy(restart_count=None):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                state = details()
                if state["State"].get("Health", {}).get("Status") == "healthy" and (restart_count is None or state["RestartCount"] > restart_count):
                    request("/ready")
                    return state
                time.sleep(0.1)
            raise AssertionError("Isolated Compose container did not become healthy")

        try:
            config = json.loads(subprocess.run([*base, "config", "--format", "json"], cwd=ROOT, env=environment, check=True, capture_output=True, text=True).stdout)
            assert set(config["services"]) == {"else"}
            service = config["services"]["else"]
            assert service["image"] == "ghcr.io/theroisey/else:latest" and service["container_name"] == "else"
            assert config["volumes"]["else_data"]["name"] == "roisey-else-data"
            assert "build" not in service and service["read_only"] and service["cap_drop"] == ["ALL"]
            assert len(service["ports"]) == 1 and service["ports"][0]["target"] == 8080 and service["ports"][0]["host_ip"] == "127.0.0.1"
            assert service["tmpfs"] and "profiles" not in service
            isolated(identity, identity)
            created = True
            workflow("up", stdout=subprocess.DEVNULL)
            healthy()
            request("/health")
            assert b'<html' in request("/app/clients")
            subprocess.run([docker, "cp", identity + ":" + DATA + "/else.sqlite3", str(Path(temporary) / "fresh.sqlite3")], check=True, stdout=subprocess.DEVNULL)
            runtime_fixture.install(identity)
            runtime = runtime_fixture.inspect(identity)
            login = {"email": "compose.synthetic@example.com", "display_name": "Synthetic operator", "password": "synthetic compose password"}
            workflow("bootstrap", input=json.dumps(login), text=True, stdout=subprocess.DEVNULL)
            actor = request("/api/v1/auth/login", {key: login[key] for key in ("email", "password")})["data"]["user"]["id"]
            client = request("/api/v1/clients", {"name": "Synthetic retained Compose account"}, 201)["data"]["id"]
            inventory = workflow("key-inventory", input=json.dumps({"actor_id": actor}), text=True, capture_output=True)
            counts = json.loads(inventory.stdout.splitlines()[-1])
            assert len(counts) == 1 and counts[0]["active"] and counts[0]["stored_rows"] == "0"
            rotation = workflow("rotate-credentials", input=json.dumps({"actor_id": actor, "client_id": client, "limit": 1, "confirmed": True}), text=True, capture_output=True)
            assert json.loads(rotation.stdout.splitlines()[-1])["rewrapped"] == 0
            # Liveness remains distinct from required-cache readiness.
            runtime_fixture.action(identity, "pause")
            try:
                request("/ready", expected=503)
                request("/health")
                assert subprocess.run([docker, "exec", identity, "/roisey-else", "health"], capture_output=True).returncode != 0
            finally:
                runtime_fixture.action(identity, "resume")
            request("/ready")
            workflow("restart", stdout=subprocess.DEVNULL)
            healthy()
            assert request("/api/v1/clients/" + client)["data"]["name"] == "Synthetic retained Compose account"
            before = details()["RestartCount"]
            runtime_fixture.action(identity, "kill")
            state = healthy(before)
            assert request("/api/v1/clients/" + client)["data"]["name"] == "Synthetic retained Compose account"
            assert runtime_fixture.inspect(identity)["redis_parent"] == 1
            logs = subprocess.run([docker, "logs", identity], check=True, capture_output=True, text=True)
            fields = [json.loads(line)["fields"] for line in (logs.stdout + logs.stderr).splitlines() if line.startswith('{')]
            assert any(row.get("error_code") == "embedded_redis_exited" and row.get("stage") == "runtime" for row in fields)
            sequence = [row["message"] for row in fields]
            expected_sequence = ["application_starting", "data_directory_ready", "embedded_redis_starting", "embedded_redis_ready", "database_ready", "migrations_ready", "keyring_ready", "frontend_ready", "server_listening"]
            assert sequence[:len(expected_sequence)] == expected_sequence
            assert all(value not in (logs.stdout + logs.stderr) for value in (login["password"], "Synthetic retained Compose account", "key_base64"))
            compose("up", "--detach", "--force-recreate", "--wait", "--wait-timeout", "60", stdout=subprocess.DEVNULL)
            assert request("/api/v1/clients/" + client)["data"]["name"] == "Synthetic retained Compose account"
            workflow("backup", "BACKUP_NAME=verified", stdout=subprocess.DEVNULL)
            bundle = Path(temporary) / "bundle"
            subprocess.run([docker, "cp", identity + ":" + DATA + "/backups/verified", str(bundle)], check=True, stdout=subprocess.DEVNULL)
            workflow("down", stdout=subprocess.DEVNULL)
            subprocess.run([docker, "volume", "inspect", identity], check=True, stdout=subprocess.DEVNULL)
            isolated(recovered, identity)
            workflow("restore", "BACKUP_SOURCE=" + str(bundle), stdout=subprocess.DEVNULL)
            workflow("up", stdout=subprocess.DEVNULL)
            healthy()
            assert request("/api/v1/clients/" + client)["data"]["name"] == "Synthetic retained Compose account"
            result = {"checks": "fresh-single-service/health/UI/API/SQLite/owned-loopback-Redis/readiness-pause/restart/child-failure-whole-restart/recreate/online-backup/off-host-empty-target-restore", "source_image": image, "redis": runtime, "restart_count_after_failure": state["RestartCount"], "startup_sequence": expected_sequence}
            print(json.dumps(result, sort_keys=True))
            if evidence:
                evidence.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
        finally:
            if created:
                compose("down", "--remove-orphans", "--volumes", stdout=subprocess.DEVNULL)
                subprocess.run([docker, "volume", "rm", identity, recovered], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="else-application:ci")
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    main(args.image, args.evidence)
