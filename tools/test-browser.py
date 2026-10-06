#!/usr/bin/env python3
"""Exercise prebuilt React assets through native Pingora with private synthetic SQLite."""
import argparse
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent


def docker(*args, **kwargs):
    return subprocess.run([os.environ.get("DOCKER", "docker"), *args], check=True, **kwargs)


def run(args):
    if not args.no_build:
        subprocess.run([os.environ.get("CARGO", "cargo"), "build", "--locked", "--bin", "roisey-else", "--example", "browser-fixture"], cwd=ROOT, check=True)
        subprocess.run(["make", "frontend-build"], cwd=ROOT, check=True)
    binary = args.binary.resolve()
    fixture = args.fixture_binary.resolve()
    with tempfile.TemporaryDirectory(prefix="else-browser-") as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        (directory / ".fixture-control").write_bytes(b"disposable-synthetic-browser-fixture")
        if not args.image:
            shutil.copytree(ROOT / "frontend/dist", directory / "frontend")
        with socket.socket() as selected:
            selected.bind(("127.0.0.1", 0))
            port = selected.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        env = os.environ.copy()
        for key in ("DATABASE_URL", "REDIS_URL", "INTEGRATION_KEYRING_FILE", "INTEGRATION_KEYRING_MODE"):
            env.pop(key, None)
        env.update(AUTH_TEST_DIRECTORY=temporary, AUTH_TEST_FIXTURE_BINARY=str(fixture), AUTH_TEST_ORIGIN=origin,
                   DATABASE_PATH=str(directory / "else.sqlite3"), FRONTEND_DIRECTORY=str(directory / "frontend"),
                   HTTP_ADDRESS=f"127.0.0.1:{port}", AUTH_PUBLIC_ORIGIN=origin, AUTH_COOKIE_SECURE="false")
        subprocess.run([str(fixture)], input=(ROOT / "frontend/e2e/fixtures.sql").read_bytes(), env=env, check=True)
        with (directory / "server.log").open("wb") as log:
            container = "else-browser-test-" + uuid.uuid4().hex if args.image else None
            if container:
                # The disposable SQL helper and server share the invoking non-root
                # UID and private bind mount. The production UID is checked by the
                # independent image/recovery gate; this uses the EXACT same image.
                docker("run", "--detach", "--name", container, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                       "--user", f"{os.getuid()}:{os.getgid()}", "--memory=256m", "--cpus=2",
                       "--publish", f"127.0.0.1:{port}:8080", "--mount", f"type=bind,src={directory},dst=/testdata",
                       "-e", "DATABASE_PATH=/testdata/else.sqlite3", "-e", "AUTH_PUBLIC_ORIGIN=" + origin,
                       "-e", "AUTH_COOKIE_SECURE=false", "-e", "REDIS_URL=", args.image, stdout=subprocess.DEVNULL)
                process = None
            else:
                process = subprocess.Popen([str(binary), "serve"], env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 20
                while True:
                    stopped = (docker("inspect", "--format", "{{.State.Running}}", container, capture_output=True, text=True).stdout.strip() != "true") if container else process.poll() is not None
                    if stopped:
                        raise SystemExit("Disposable Pingora browser server exited during startup.")
                    try:
                        with urllib.request.urlopen(origin + "/ready", timeout=2) as response:
                            if response.status == 200:
                                break
                    except (urllib.error.URLError, TimeoutError, ConnectionResetError):
                        if time.monotonic() > deadline:
                            raise SystemExit("Disposable Pingora browser readiness timed out.")
                        time.sleep(0.05)
                node = os.environ.get("NODE", "node")
                subprocess.run([node, str(ROOT / "frontend/scripts/check-runtime-security.mjs"), origin], cwd=ROOT, env=env, check=True)
                command = [node, "node_modules/@playwright/test/cli.js", "test"]
                if args.grep:
                    command += ["--grep", args.grep]
                subprocess.run(command, cwd=ROOT / "frontend", env=env, check=True)
            finally:
                if container:
                    try:
                        if docker("inspect", "--format", "{{.State.Running}}", container, capture_output=True, text=True).stdout.strip() == "true":
                            docker("kill", "--signal=TERM", container, stdout=subprocess.DEVNULL)
                            result = docker("wait", container, capture_output=True, text=True, timeout=15)
                            if result.stdout.strip() != "0":
                                raise SystemExit("Disposable image server did not stop gracefully.")
                    finally:
                        docker("rm", "--force", container, stdout=subprocess.DEVNULL)
                elif process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                        raise SystemExit("Disposable Pingora server did not stop gracefully.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "target/debug/roisey-else")
    parser.add_argument("--fixture-binary", type=Path, default=ROOT / "target/debug/examples/browser-fixture")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--grep")
    parser.add_argument("--image", help="Exercise this exact Docker image with the private native SQL fixture helper")
    run(parser.parse_args())
