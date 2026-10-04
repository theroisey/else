"""Isolated container fixture and protected API stamp verification; no real data."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def prepare(path):
    # Public deterministic synthetic tokens, usable only in disposable test data.
    tokens = [bytes([n]) * 32 for n in (1, 2)]
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump([base64.urlsafe_b64encode(t).decode().rstrip("=") for t in tokens], output)
    for n, token in enumerate(tokens, 1):
        user = f"ac000000-0000-4000-8000-{n:012d}"
        role = "00000000-0000-4000-8000-000000000001" if n == 1 else "00000000-0000-4000-8000-000000000003"
        password = "$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZS1vbmx5c2FsdA$q44qWGtBzhKQ/qhlHB+AxsHnTl623ugz2P+BkSW2ZxQ"
        print(f"INSERT INTO app.users(id,email,display_name,password_hash) VALUES ('{user}','release-{n}@example.com','Synthetic release fixture','{password}');")
        print(f"INSERT INTO app.user_roles(id,user_id,role_id,scope_kind) VALUES ('ad000000-0000-4000-8000-{n:012d}','{user}','{role}','global');")
        digest = hashlib.sha256(token).hexdigest()
        print(f"INSERT INTO app.sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES ('ae000000-0000-4000-8000-{n:012d}','{user}',decode('{digest}','hex'),decode('{digest}','hex'),clock_timestamp()+interval '1 hour');")


def verify(path, origin, revision, built_at):
    tokens = json.loads(Path(path).read_text())
    def read(suffix="", token=None, method="GET"):
        headers = {} if token is None else {"Cookie": "else_session=" + token}
        request = urllib.request.Request(origin + "/api/v1/releases" + suffix, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(4097)
            assert len(raw) <= 4096 and response.headers.get("Cache-Control") == "no-store"
            return response.status, raw
    assert read()[0] == 401
    assert read(token=tokens[1])[0] == 403
    status, raw = read(token=tokens[0])
    assert status == 200
    runtime = {"status": "available", "version": "sha-" + revision, "commit_sha": revision, "built_at": built_at} if revision else {"status": "unavailable", "version": None, "commit_sha": None, "built_at": None}
    assert json.loads(raw) == {"data": {
        "runtime": runtime,
        "latest_release": {"status": "unavailable"}, "image_provenance": {"status": "unavailable"}, "deployment": {"status": "unavailable"},
    }}
    assert read("?source=synthetic", tokens[0])[0] == 400
    assert read("/extra", tokens[0])[0] == 400
    assert read(token=tokens[0], method="POST")[0] == 405
    print("CI-produced API build metadata and protected release reads verified.")


try:
    if len(sys.argv) == 3 and sys.argv[1] == "prepare":
        prepare(sys.argv[2])
    elif len(sys.argv) == 6 and sys.argv[1] == "verify":
        verify(*sys.argv[2:])
    else:
        raise ValueError()
except Exception:
    print("Release runtime verification failed.", file=sys.stderr)
    sys.exit(1)
