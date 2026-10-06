#!/usr/bin/env python3
"""Rehearse the real one-image Compose file on explicitly owned empty storage."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent


def main(image):
    identity = "else-compose-test-" + uuid.uuid4().hex
    environment = {key: value for key, value in os.environ.items() if not key.startswith("COMPOSE_")}
    with socket.socket() as selected:
        selected.bind(("127.0.0.1", 0))
        port = selected.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    environment.update(ELSE_IMAGE=image, ELSE_DATA_VOLUME=identity, APP_PORT=str(port),
                       AUTH_PUBLIC_ORIGIN=origin, AUTH_COOKIE_SECURE="false", REDIS_URL="")
    docker = os.environ.get("DOCKER", "docker")
    created = False
    recovered = identity + "-restored"
    with tempfile.TemporaryDirectory(prefix=identity) as temporary:
        env_file = Path(temporary) / "empty.env"
        env_file.write_text("")
        command = [docker, "compose", "--env-file", str(env_file), "--file", str(ROOT / "docker-compose.yml"), "--project-name", identity]

        def compose(*arguments, **kwargs):
            return subprocess.run([*command, *arguments], cwd=ROOT, env=environment, check=True, **kwargs)

        def workflow(target, *variables, **kwargs):
            return subprocess.run(["make", "COMPOSE=" + shlex.join(command), target, *variables],
                                  cwd=ROOT, env=environment, check=True, **kwargs)

        cookies = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies), urllib.request.ProxyHandler({}))

        def request(path, payload=None):
            headers = {}
            body = None
            if payload is not None:
                body = json.dumps(payload).encode()
                headers = {"Origin": origin, "Content-Type": "application/json"}
                csrf = next((cookie.value for cookie in cookies if cookie.name == "else_csrf"), None)
                if csrf:
                    headers["X-CSRF-Token"] = csrf
            with opener.open(urllib.request.Request(origin + path, body, headers), timeout=5) as response:
                assert response.status in (200, 201)
                return json.loads(response.read())

        try:
            config = json.loads(compose("config", "--format", "json", capture_output=True, text=True).stdout)
            assert set(config["services"]) == {"else"}, "default deployment must contain one service"
            assert "build" not in config["services"]["else"] and config["services"]["else"]["read_only"]
            login = {"email": "compose.synthetic@example.com", "display_name": "Synthetic operator", "password": "synthetic compose password"}
            # This command initializes only the explicitly named test volume.
            created = True
            workflow("bootstrap", input=json.dumps(login), text=True, stdout=subprocess.DEVNULL)
            workflow("up", stdout=subprocess.DEVNULL)
            request("/ready")
            actor = request("/api/v1/auth/login", {key: login[key] for key in ("email", "password")})["data"]["user"]["id"]
            client = request("/api/v1/clients", {"name": "Synthetic retained Compose account"})["data"]["id"]
            inventory = workflow("key-inventory", input=json.dumps({"actor_id": actor}), text=True, capture_output=True)
            counts = json.loads(inventory.stdout.splitlines()[-1])
            assert len(counts) == 1 and counts[0]["active"] and counts[0]["stored_rows"] == "0"
            rotation = workflow("rotate-credentials", input=json.dumps({"actor_id": actor, "client_id": client, "limit": 1, "confirmed": True}), text=True, capture_output=True)
            assert json.loads(rotation.stdout.splitlines()[-1])["rewrapped"] == 0
            workflow("backup", "BACKUP_NAME=verified", stdout=subprocess.DEVNULL)
            workflow("down", stdout=subprocess.DEVNULL)
            subprocess.run([docker, "volume", "inspect", identity], check=True, stdout=subprocess.DEVNULL)
            workflow("restore", "BACKUP_NAME=verified", "SOURCE_VOLUME=" + identity,
                     "RESTORE_VOLUME=" + recovered, stdout=subprocess.DEVNULL)
            environment["ELSE_DATA_VOLUME"] = recovered
            workflow("up", stdout=subprocess.DEVNULL)
            assert request("/api/v1/clients/" + client)["data"]["name"] == "Synthetic retained Compose account"
            workflow("down", stdout=subprocess.DEVNULL)
            environment["ELSE_DATA_VOLUME"] = identity
            # Recreate with the optional official Redis service and same storage.
            environment["REDIS_URL"] = "redis://redis:6379/0"
            compose("--profile", "cache", "up", "--detach", "--wait", "--wait-timeout", "60", stdout=subprocess.DEVNULL)
            request("/ready")
            assert request("/api/v1/clients/" + client)["data"]["name"] == "Synthetic retained Compose account"
            assert compose("--profile", "cache", "exec", "-T", "redis", "redis-cli", "ping", capture_output=True, text=True).stdout.strip() == "PONG"
            redis_id = compose("--profile", "cache", "ps", "--quiet", "redis", capture_output=True, text=True).stdout.strip()
            details = json.loads(subprocess.run([docker, "inspect", redis_id], check=True, capture_output=True, text=True).stdout)[0]
            assert details["Config"]["User"] == "999:999" and details["HostConfig"]["ReadonlyRootfs"]
            print("Actual Make/Compose: private bootstrap, inventory, bounded rotation, online backup, empty-target restore, one default image, retained storage and optional nonroot read-only Redis passed.")
        finally:
            if created:
                # --volumes is limited to this random disposable project. The
                # named application volume is externally named and removed below.
                compose("--profile", "cache", "down", "--volumes", stdout=subprocess.DEVNULL)
                subprocess.run([docker, "volume", "rm", identity, recovered], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="else-application:ci")
    main(parser.parse_args().image)
