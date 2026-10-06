#!/usr/bin/env python3
"""Verify the exact runtime image on owned volumes, including real recovery."""
import argparse
import gzip
import http.cookiejar
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
DATA = "/var/lib/roisey-else"


def docker(*args, check=True, **kwargs):
    return subprocess.run([os.environ.get("DOCKER", "docker"), *args], check=check, **kwargs)


def output(*args):
    return docker(*args, capture_output=True, text=True).stdout.strip()


def run(args):
    prefix = "else-image-test-" + uuid.uuid4().hex
    volumes, containers, operator_containers, operator_logs = [], [], [], []
    with tempfile.TemporaryDirectory(prefix=prefix) as temporary:
        directory = Path(temporary)
        with socket.socket() as selected:
            selected.bind(("127.0.0.1", 0))
            port = selected.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        common = ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=256m", "--cpus=2",
                  "-e", "AUTH_PUBLIC_ORIGIN=" + origin, "-e", "AUTH_COOKIE_SECURE=false", "-e", "REDIS_URL=redis://127.0.0.1:1/0"]
        config = json.loads(output("image", "inspect", args.image))[0]
        assert config["Config"]["User"] == "65532:65532", "runtime must default to non-root"
        assert config["Config"]["Entrypoint"] == ["/roisey-else"]
        assert config["Config"]["Cmd"] == ["serve"]
        assert config["Size"] < 100 * 1024 * 1024, "runtime image exceeds 100 MiB budget"
        cookies = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies), urllib.request.ProxyHandler({}))

        def request(path, method="GET", payload=None, expected=200, headers=None):
            fields = dict(headers or {})
            data = None if payload is None else json.dumps(payload).encode()
            if payload is not None:
                fields.update({"Content-Type": "application/json", "Origin": origin})
                csrf = next((c.value for c in cookies if c.name == "else_csrf"), None)
                if csrf:
                    fields["X-CSRF-Token"] = csrf
            call = urllib.request.Request(origin + path, data=data, headers=fields, method=method)
            try:
                response = opener.open(call, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                raw = response.read()
                assert response.status == expected, f"{method} {path}: {response.status} != {expected}"
                assert response.headers.get("X-Content-Type-Options") == "nosniff"
                assert response.headers.get("Content-Security-Policy")
                if path.startswith("/api/"):
                    assert response.headers.get("Cache-Control") == "no-store"
                return (json.loads(raw) if response.headers.get("Content-Type", "").startswith("application/json") and raw else raw), response.headers

        def volume(suffix):
            name = prefix + suffix
            docker("volume", "create", "--label", "roisey.else.test=runtime", name, stdout=subprocess.DEVNULL)
            volumes.append(name)
            return name

        def operator(storage, command, extra=(), payload=None, expected=0):
            name = prefix + "-operator-" + uuid.uuid4().hex
            operator_containers.append(name)
            result = docker("run", "--rm", "--name", name, "-i", *common, "--mount", f"type=volume,src={storage},dst={DATA}",
                            *extra, args.image, command, input=payload, capture_output=True, text=True, check=False, timeout=60)
            operator_logs.append(result.stdout + result.stderr)
            succeeded = result.returncode == 0 if expected == 0 else result.returncode != 0
            if not succeeded:
                # Native diagnostics are fixed redacted codes, not raw SQL or
                # provider data. Keep only the final recognized failure code.
                code = "operator_failure"
                for line in result.stderr.splitlines():
                    try:
                        diagnostic = json.loads(line)
                        candidate = diagnostic.get("fields", {}).get("error_code", "")
                        if candidate and len(candidate) <= 80 and all(c in "abcdefghijklmnopqrstuvwxyz_" for c in candidate):
                            code = candidate
                    except (ValueError, AttributeError, TypeError):
                        continue
                raise AssertionError(f"operator {command} returned {result.returncode}: {code}")
            return result

        def ready(name):
            deadline = time.monotonic() + 30
            while True:
                if output("inspect", "--format", "{{.State.Running}}", name) != "true":
                    diagnostic = docker("logs", name, capture_output=True, text=True)
                    print(diagnostic.stdout + diagnostic.stderr)
                    raise AssertionError("runtime exited during startup")
                try:
                    request("/ready")
                    return
                except (urllib.error.URLError, TimeoutError, ConnectionResetError):
                    assert time.monotonic() < deadline, "runtime readiness timed out"
                    time.sleep(0.05)

        def start(storage, suffix):
            name = prefix + suffix
            docker("run", "--detach", "--name", name, *common, "--publish", f"127.0.0.1:{port}:8080", "--mount",
                   f"type=volume,src={storage},dst={DATA}", args.image, stdout=subprocess.DEVNULL)
            containers.append(name)
            ready(name)
            return name

        def stop(name, sig):
            docker("kill", "--signal=" + sig, name, stdout=subprocess.DEVNULL)
            result = docker("wait", name, capture_output=True, text=True, timeout=15)
            assert result.stdout.strip() == "0", f"runtime did not drain on {sig}"

        def copied(name, source, destination):
            docker("cp", name + ":" + source, str(destination), stdout=subprocess.DEVNULL)
            return destination

        try:
            original = volume("-source")
            login = {"email": "image.synthetic@example.com", "display_name": "Synthetic image operator", "password": "synthetic image test password"}
            operator(original, "bootstrap", payload=json.dumps(login))
            name = start(original, "-app")
            # Docker top lists processes (not Rust worker threads). PID 1 is the sole application.
            processes = output("top", name, "-eo", "pid,comm").splitlines()
            assert len(processes) == 2 and processes[1].split()[-1] == "roisey-else"
            docker("exec", name, "/roisey-else", "health", stdout=subprocess.DEVNULL)
            settings = json.loads(output("inspect", name))[0]["HostConfig"]
            assert settings["ReadonlyRootfs"] and settings["CapDrop"] == ["ALL"]
            archive = directory / "filesystem.tar"
            docker("export", "--output", str(archive), name, stdout=subprocess.DEVNULL)
            with tarfile.open(archive) as files:
                assert all(member.mode & 0o111 for member in files if member.isdir()), "runtime directories must permit traversal"
                data_directory = files.getmember(DATA.lstrip("/"))
                assert data_directory.isdir() and data_directory.mode == 0o700 and data_directory.uid == data_directory.gid == 65532, "image data directory must be privately owned"
                paths = {member.name.lstrip("/") for member in files}
                forbidden = ("bin/sh", "usr/bin/node", "usr/bin/npm", "usr/bin/cargo", "usr/bin/rustc", "usr/bin/postgres", "app/frontend/src", "app/frontend/node_modules")
                assert all(not any(p == key or p.startswith(key + "/") for p in paths) for key in forbidden)
                assert "roisey-else" in paths and "app/frontend/index.html" in paths
            archive.unlink()
            index, _ = request("/app/clients")
            assert index == (ROOT / "frontend/dist/index.html").read_bytes()
            asset = next((ROOT / "frontend/dist/assets").glob("*.js.gz"))
            encoded, headers = request("/assets/" + asset.name[:-3], headers={"Accept-Encoding": "gzip"})
            assert headers["Content-Encoding"] == "gzip" and "immutable" in headers["Cache-Control"]
            assert gzip.decompress(encoded) == asset.with_suffix("").read_bytes()
            request("/assets/missing.js", expected=404)
            request("/%2e%2e/private", expected=404)
            request("/api/v1/releases", expected=404)
            request("/api/v1/auth/session", expected=401)
            request("/api/v1/auth/login", "POST", {k: login[k] for k in ("email", "password")})
            client, _ = request("/api/v1/clients", "POST", {"name": "Synthetic persistent account"}, 201)
            root = "/api/v1/clients/" + client["data"]["id"]
            request(root + "/tasks", "POST", {"title": "Synthetic task", "due_at": "2020-01-01T00:00:00Z"}, 201)
            request(root + "/billing", "POST", {"description": "Synthetic invoice", "amount_minor": "9007199254740993", "currency": "EUR"}, 201)
            overview, _ = request(root + "/overview")
            assert overview["data"]["finance"]["currencies"][0]["outstanding_minor"] == "9007199254740993"
            assert len(overview["data"]["tasks"]["overdue"]["items"]) == 1
            collision = operator(original, "serve", expected=1)
            assert "application_is_running" in collision.stderr, "shared-volume ownership was not refused"
            docker("exec", "-e", f"BACKUP_DIRECTORY={DATA}/backups/verified", name, "/roisey-else", "backup", stdout=subprocess.DEVNULL)
            operator(original, "backup", ("-e", f"BACKUP_DIRECTORY={DATA}/backups/verified"), expected=1)
            key_before = json.loads(copied(name, DATA + "/.control/integration-keyring.json", directory / "key-before.json").read_text())
            data_directory = copied(name, DATA, directory / "data-directory-metadata-only")
            assert data_directory.stat().st_mode & 0o777 == 0o700, "mounted data directory must preserve private permissions"
            db_file = copied(name, DATA + "/else.sqlite3", directory / "database-metadata-only.sqlite3")
            assert db_file.stat().st_mode & 0o777 == 0o600
            assert (directory / "key-before.json").stat().st_mode & 0o777 == 0o400
            stop(name, "TERM")
            docker("start", name, stdout=subprocess.DEVNULL)
            ready(name)
            retained, _ = request(root)
            assert retained["data"]["name"] == "Synthetic persistent account"
            stop(name, "INT")
            restored = volume("-restored")
            restore_mounts = ("--mount", f"type=volume,src={original},dst=/backup-source,readonly", "-e", "BACKUP_DIRECTORY=/backup-source/backups/verified")
            operator(original, "restore", restore_mounts, expected=1)
            blocked = volume("-blocked")
            invalid_source = ("--mount", f"type=volume,src={original},dst=/backup-source,readonly", "-e", "BACKUP_DIRECTORY=/backup-source/backups/not-present")
            operator(blocked, "restore", invalid_source, expected=1)
            refused = operator(blocked, "serve", expected=1)
            assert "restore_incomplete" in refused.stderr, "failed recovery must never become a fresh installation"
            operator(restored, "restore", restore_mounts)
            recovered = start(restored, "-recovered")
            # Sessions, immutable exact amounts and histories survive supported backup/restore.
            recovered_overview, _ = request(root + "/overview")
            assert recovered_overview["data"]["finance"] == overview["data"]["finance"]
            assert recovered_overview["data"]["tasks"] == overview["data"]["tasks"]
            audit, _ = request(root + "/audit-logs")
            assert len(audit["data"]) >= 3
            key_after = json.loads(copied(recovered, DATA + "/.control/integration-keyring.json", directory / "key-after.json").read_text())
            assert key_after["active_key_id"] != key_before["active_key_id"]
            assert len(key_after["keys"]) == len(key_before["keys"]) + 1
            assert all(k in key_after["keys"] for k in key_before["keys"])
            stop(recovered, "TERM")
            private = [login["password"], "Synthetic persistent account", "9007199254740993", "key_base64"]
            for container in containers:
                result = docker("logs", container, capture_output=True, text=True)
                logs = result.stdout + result.stderr
                assert all(value not in logs for value in private), "private input appeared in runtime logs"
            for logs in operator_logs:
                assert all(value not in logs for value in private), "private input appeared in operator output"
            evidence = {"image_id": config["Id"], "size_bytes": config["Size"], "pid1": "roisey-else", "runtime_uid": 65532,
                        "checks": "HTTP/static/gzip/auth/exact-finance/cache-outage/readonly/persistence/ownership/TERM/INT/online-backup/fresh-key-restore/failed-recovery-startup-refusal"}
            print(json.dumps(evidence, sort_keys=True))
            if args.evidence:
                args.evidence.parent.mkdir(parents=True, exist_ok=True)
                args.evidence.write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n")
            if args.archive:
                docker("save", "--output", str(args.archive), args.image)
        finally:
            for container in reversed(containers + operator_containers):
                docker("rm", "--force", container, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for storage in reversed(volumes):
                docker("volume", "rm", storage, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="else-application:ci")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--evidence", type=Path)
    run(parser.parse_args())
