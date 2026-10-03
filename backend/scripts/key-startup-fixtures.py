"""Isolated container-test data only. Never provision these synthetic keys."""
import base64
import hashlib
import json
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
target.mkdir(mode=0o755)
target.chmod(0o755)  # The non-root runtime must traverse the read-only mount.
material = b"\x6b" * 32  # Deliberately public synthetic fixture.
document = {"active_key_id": "synthetic-container", "keys": [
    {"id": "synthetic-container", "key_base64": base64.b64encode(material).decode("ascii")}
]}
for name in ("protected.json", "public.json"):
    (target / name).write_text(json.dumps(document), encoding="utf-8")
fresh_document = {"active_key_id": "synthetic-fresh", "keys": document["keys"] + [
    {"id": "synthetic-fresh", "key_base64": base64.b64encode(b"\x73" * 32).decode("ascii")}
]}
(target / "fresh.json").write_text(json.dumps(fresh_document), encoding="utf-8")
(target / "malformed.json").write_text('{"synthetic-private-parser-value":true}', encoding="utf-8")
(target / "symlink.json").symlink_to("protected.json")
(target / "register.sql").write_text(
    "INSERT INTO app.integration_encryption_keys(key_label,fingerprint,reservations) "
    "VALUES('synthetic-container',decode('" + hashlib.sha256(material).hexdigest() + "','hex'),1);\n",
    encoding="utf-8",
)
