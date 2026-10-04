"""Create/read a real authorized client across disposable container replacements."""
import json
import os
from pathlib import Path
import sys
import urllib.request

action, record_path, cookie_path, base = sys.argv[1:]
token = json.loads(Path(cookie_path).read_text())[0]
profile = {"name": "Synthetic persistent container client", "legal_name": "Synthetic fixture",
           "website": "https://example.com", "notes": "Disposable verification only", "contacts": [], "tags": ["synthetic"]}
headers = {"Cookie": f"else_session={token}; else_csrf={token}", "Origin": "http://localhost:8080",
           "Content-Type": "application/json", "X-CSRF-Token": token}
if action == "create":
    request = urllib.request.Request(base + "/api/v1/clients", headers=headers,
                                     data=json.dumps(profile).encode(), method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        assert response.status == 201
        record = json.load(response)["data"]
    with os.fdopen(os.open(record_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(record, output)
elif action == "verify":
    record = json.loads(Path(record_path).read_text())
    request = urllib.request.Request(base + "/api/v1/clients/" + record["id"], headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        assert response.status == 200
        current = json.load(response)["data"]
    for key, value in profile.items():
        assert current[key] == value, key
    assert current["id"] == record["id"] and current["revision"] == record["revision"]
else:
    raise SystemExit("Unsupported fixture action")
print("Authorized synthetic client and revision verified.")
