"""Verify declared browser headers on actual single-process runtime responses."""
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import urlopen


def verify():
    origin = sys.argv[1]
    parsed = urlsplit(origin)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ("", "/")):
        raise ValueError("private test origin required")
    policy = Path(__file__).resolve().parents[2].joinpath("backend/internal/http/browser-headers.json")
    names = ("Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy")
    expected = json.loads(policy.read_text())
    if set(expected) != set(names):
        raise ValueError("declared header missing")
    if (expected["X-Frame-Options"] != "DENY" or expected["X-Content-Type-Options"] != "nosniff"
            or expected["Referrer-Policy"] != "no-referrer"
            or "'unsafe-inline'" in expected["Content-Security-Policy"]
            or "'unsafe-eval'" in expected["Content-Security-Policy"]):
        raise ValueError("declared security policy weakened")
    assets = []
    routes = [("/", 200), ("/app/access", 200), ("/status", 200), ("/health", 200),
              ("/ready", 200), ("/api/v1/auth/session", 401), ("/api/v1/unknown", 404), ("/api/unknown", 404)]
    for path, status in routes:
        try:
            response = urlopen(origin.rstrip("/") + path, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            if response.code != status:
                raise ValueError("unexpected runtime route status")
            for name in names:
                if response.headers.get_all(name) != [expected[name]]:
                    raise ValueError("runtime header missing, changed or duplicated")
            if path == "/":
                html = response.read(65537)
                if len(html) > 65536:
                    raise ValueError("unexpected runtime index size")
                assets = re.findall(r'(?:src|href)="(/assets/[^"?#]+\.(?:js|css))"', html.decode())
    if not assets:
        raise ValueError("built runtime assets unavailable")
    for asset in assets:
        with urlopen(origin.rstrip("/") + asset, timeout=5) as response:
            if response.code != 200 or any(response.headers.get_all(name) != [expected[name]] for name in names):
                raise ValueError("runtime asset security headers differ")


if __name__ == "__main__":
    try:
        verify()
        print("Actual Go SPA/asset/public/API/error security headers verified without duplicates.")
    except Exception:
        print("Actual runtime security header verification failed.", file=sys.stderr)
        sys.exit(1)
