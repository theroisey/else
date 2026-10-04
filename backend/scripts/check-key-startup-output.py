"""Check fixed startup diagnostics without printing raw test-container logs."""
import base64
import hashlib
import json
import pathlib
import sys

raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
events = []
for line in raw.splitlines():
    try:
        events.append(json.loads(line))
    except (ValueError, TypeError):
        continue
expected = sys.argv[2] if len(sys.argv) == 3 else "integration_key_startup_failed"
if not any(isinstance(event, dict) and event.get("msg") == expected for event in events):
    raise SystemExit("Expected fixed key startup failure was absent.")
private_values = ["synthetic-container", "synthetic-fresh", "synthetic-private-parser-value", "/run/integration-keys", "key_base64", "active_key_id"]
for material in (b"\x6b" * 32, b"\x73" * 32):  # Public synthetic fixture only.
    private_values.extend((base64.b64encode(material).decode("ascii"), hashlib.sha256(material).hexdigest()))
if any(value in raw for value in private_values):
    raise SystemExit("Key startup output exposed private context.")
