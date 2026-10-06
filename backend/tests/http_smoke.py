#!/usr/bin/env python3
"""Exercise the compiled Pingora process with disposable synthetic data."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def run(binary: Path, frontend: Path, stop_signal: int) -> None:
    with tempfile.TemporaryDirectory(prefix="else-pingora-smoke-") as temporary:
        directory = Path(temporary)
        with socket.socket() as selection:
            selection.bind(("127.0.0.1", 0))
            port = selection.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        environment = os.environ.copy()
        for key in ("INTEGRATION_KEYRING_FILE", "INTEGRATION_KEYRING_MODE"):
            environment.pop(key, None)
        environment.update(HTTP_ADDRESS=f"127.0.0.1:{port}", DATABASE_PATH=str(directory / "else.sqlite3"), FRONTEND_DIRECTORY=str(frontend), AUTH_PUBLIC_ORIGIN=origin, AUTH_COOKIE_SECURE="false")
        bootstrap = {"email": "smoke@example.com", "display_name": "Synthetic operator", "password": "synthetic-smoke-password"}
        result = subprocess.run([str(binary), "bootstrap"], input=json.dumps(bootstrap), text=True, env=environment, capture_output=True, timeout=15)
        assert result.returncode == 0, "bootstrap failed"
        cookies = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

        def request(path, method="GET", payload=None, expected=200, extra=None, csrf=True):
            headers = dict(extra or {})
            data = None if payload is None else json.dumps(payload).encode()
            if payload is not None:
                headers.update({"Content-Type": "application/json", "Origin": origin})
                if csrf:
                    token = next((c.value for c in cookies if c.name == "else_csrf"), "")
                    if token:
                        headers["X-CSRF-Token"] = token
            call = urllib.request.Request(origin + path, data=data, headers=headers, method=method)
            try:
                response = opener.open(call, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                body = response.read()
                assert response.status == expected, f"{method} {path}: {response.status} != {expected}"
                if path.startswith("/api/"):
                    assert response.headers.get("Cache-Control") == "no-store"
                assert response.headers.get("X-Content-Type-Options") == "nosniff"
                assert response.headers.get("Content-Security-Policy")
                return json.loads(body) if body and response.headers.get("Content-Type", "").startswith("application/json") else body, response.headers

        with (directory / "server.log").open("wb") as log:
            process = subprocess.Popen([str(binary), "serve"], env=environment, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 15
                while True:
                    assert process.poll() is None, "server exited during startup"
                    try:
                        request("/ready")
                        break
                    except urllib.error.URLError:
                        assert time.monotonic() < deadline, "server readiness timed out"
                        time.sleep(0.05)
                request("/api/v1/auth/session", expected=401)
                login, headers = request("/api/v1/auth/login", "POST", {"email": bootstrap["email"], "password": bootstrap["password"]})
                assert login["data"]["user"]["email"] == bootstrap["email"]
                assert len(headers.get_all("Set-Cookie")) == 2
                assert all("SameSite=Strict" in value for value in headers.get_all("Set-Cookie"))
                request("/api/v1/auth/session")
                client, _ = request("/api/v1/clients", "POST", {"name": "Synthetic private client"}, 201)
                root = "/api/v1/clients/" + client["data"]["id"]
                request(root + "/tasks", "POST", {"title": "Synthetic attention", "due_at": "2020-01-01T00:00:00Z"}, 201)
                plan, _ = request(root + "/plans", "POST", {"title": "Synthetic plan"}, 201)
                request(root + "/plans/" + plan["data"]["id"] + "/milestones", "POST", {"title": "Synthetic milestone"}, 201)
                request(root + "/reminders", "POST", {"title": "Synthetic reminder", "scheduled_local": "2020-01-01T10:00:00", "timezone": "Etc/UTC", "utc_offset_seconds": 0}, 201)
                request(root + "/billing", "POST", {"description": "Synthetic private invoice", "amount_minor": "500", "currency": "EUR"}, 201)
                request(root + "/pricing", "POST", {"title": "Synthetic pricing", "currency": "EUR", "effective_from": "2020-01-01", "lines": [{"description": "Synthetic service", "kind": "one_time", "frequency": "none", "quantity_micros": "1000000", "unit_price_minor": "500", "discount_bps": "0", "tax_bps": "0"}]}, 201)
                overview, _ = request(root + "/overview")
                assert overview["data"]["finance"]["currencies"][0]["outstanding_minor"] == "500"
                assert len(overview["data"]["tasks"]["overdue"]["items"]) == 1
                assert len(overview["data"]["reminders"]["due"]["items"]) == 1
                audit, _ = request(root + "/audit-logs?limit=1")
                detail, _ = request(root + "/audit-logs/" + audit["data"][0]["id"])
                assert "Synthetic private" not in json.dumps(detail)
                request(root + "/activity")
                request(root + "/overview", "HEAD", expected=405)
                request(root + "/overview?invalid=1", expected=400)
                website, _ = request(root + "/websites", "POST", {"name": "Synthetic property", "url": "https://synthetic.example.com"}, 201)
                site = root + "/websites/" + website["data"]["id"]
                connection, _ = request(root + "/integrations/ga4", "POST", {"property_id": "123456"}, 201)
                connection_id = connection["data"]["id"]
                assert len(connection["data"]) == 7
                request(site + "/connections", "POST", {"connection_id": connection_id, "expected_revision": 1, "attach": True, "confirm": True})
                request(site + "/integrations/" + connection_id)
                reports, _ = request(root + "/analytics")
                assert reports["data"][0]["id"] == connection_id
                assert len(reports["data"][0]) == 7
                report_path = root + "/analytics/" + connection_id
                report, _ = request(report_path + "?since=2026-10-01&until=2026-10-06")
                assert report["status"]["state"] == "not_synced" and report["data"] is None
                request(report_path, expected=400)
                request(report_path + "?since=2026-10-01&since=2026-10-01&until=2026-10-06", expected=400)
                woo, _ = request(root + "/integrations/woocommerce", "POST", {"origin": "https://synthetic.invalid"}, 201)
                woo_id = woo["data"]["id"]
                setup = {"revision": "1", "start": "2026-10-01T00:00:00Z", "end": "2026-10-02T00:00:00Z", "currency": "USD", "consumer_key": "ck_" + "a" * 40, "consumer_secret": "cs_" + "b" * 40}
                queued, _ = request(root + "/integrations/" + woo_id + "/woocommerce/credentials", "POST", setup, 202)
                assert queued["state"] == "queued" and queued["connection_revision"] == "3"
                assert set(queued) == {"job_id", "state", "connection_revision"}
                failed_path = root + "/commerce/" + woo_id + "?start=2026-10-01T00%3A00%3A00Z&end=2026-10-02T00%3A00%3A00Z&currency=USD"
                deadline = time.monotonic() + 15
                while True:
                    report, _ = request(failed_path)
                    if report["status"]["state"] == "failed":
                        assert report["status"]["reason"] == "provider_unavailable" and report["data"] is None
                        break
                    assert time.monotonic() < deadline, "durable provider job did not complete"
                    time.sleep(0.05)
                request(root + "/integrations/" + connection_id + "/disconnect", "POST", {"revision": "1", "confirmed": True})
                request(root + "/tasks", "POST", {"title": "Rejected request"}, 403, csrf=False)
                request("/api/v1/unknown", expected=404)
                request("/api/v1/releases", expected=404)
                request("/assets/missing.js", expected=404)
                request("/%2e%2e/private", expected=404)
                index, headers = request("/login")
                assert b"<html" in index
                request("/app/clients/" + client["data"]["id"])
                request("/login", extra={"If-None-Match": headers["ETag"]}, expected=304)
                probe = subprocess.run([str(binary), "health"], env=environment, capture_output=True, timeout=5)
                assert probe.returncode == 0
                process.send_signal(stop_signal)
                assert process.wait(timeout=15) == 0, "graceful shutdown failed"
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        log = (directory / "server.log").read_text()
        for private in (bootstrap["password"], "Synthetic private", "synthetic.example.com", "synthetic.invalid", "ck_" + "a" * 40, "cs_" + "b" * 40, "123456", "key_base64"):
            assert private not in log, "private input leaked to server logs"
        assert (directory / ".control/integration-keyring.json").stat().st_mode & 0o777 == 0o400
        assert (directory / "else.sqlite3").stat().st_mode & 0o777 == 0o600
        print(f"Pingora HTTP, static, permissions, audit, website and {signal.Signals(stop_signal).name} smoke passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--frontend", type=Path, required=True)
    parser.add_argument("--signal", choices=("TERM", "INT"), default="TERM")
    arguments = parser.parse_args()
    run(arguments.binary.resolve(), arguments.frontend.resolve(), signal.SIGTERM if arguments.signal == "TERM" else signal.SIGINT)
