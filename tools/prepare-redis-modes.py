#!/usr/bin/env python3
"""Verify transferred Redis bytes and restore modes/loader alias lost by ZIP."""
import hashlib
import json
from pathlib import Path

BUILD = Path(__file__).resolve().parents[1] / "build"
EXPECTED = {
    "redis-server",
    "redis-runtime/lib/ld-musl-x86_64.so.1",
    "redis-runtime/usr/lib/libstdc++.so.6",
    "redis-runtime/usr/lib/libgcc_s.so.1",
    "redis-runtime/usr/lib/libssl.so.3",
    "redis-runtime/usr/lib/libcrypto.so.3",
}
record = json.loads((BUILD / "redis-artifact.json").read_text())
if set(record["artifacts"]) != EXPECTED:
    raise SystemExit("Unexpected embedded runtime artifact inventory.")
for name, checksum in record["artifacts"].items():
    path = BUILD / name
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
        raise SystemExit("Embedded runtime artifact checksum mismatch.")
    path.chmod(0o555)
runtime = BUILD / "redis-runtime"
for path in [BUILD, runtime, *[p for p in runtime.rglob("*") if p.is_dir()]]:
    if path.is_symlink():
        raise SystemExit("Embedded runtime directories must not be symlinks.")
    path.chmod(0o755)
alias = runtime / "lib/libc.musl-x86_64.so.1"
alias.unlink(missing_ok=True)
alias.symlink_to("ld-musl-x86_64.so.1")
(runtime / "tmp").mkdir(exist_ok=True)
(runtime / "tmp").chmod(0o1777)
print("Embedded runtime artifact hashes, modes and loader alias verified.")
