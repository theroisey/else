#!/usr/bin/env python3
"""Reject vulnerabilities and undispositioned advisories; keep findings visible."""
import json
import os
from pathlib import Path
import subprocess
import sys

CHECKSUM = "fcc3dd5e9e9c0b295d6e1e4d811fb6f157d5ffd784b8d202fc62eac8035a770b"


def assess(report, metadata):
    if report["database"]["advisory-count"] < 1 or not report["database"]["last-commit"]:
        raise ValueError("empty advisory database")
    vulnerabilities = report["vulnerabilities"]
    if vulnerabilities["found"] or vulnerabilities["count"] or vulnerabilities["list"]:
        raise ValueError("vulnerable dependency")
    packages = {package["id"]: package for package in metadata["packages"]}
    for category, warnings in report["warnings"].items():
        for warning in warnings:
            package, advisory = warning["package"], warning["advisory"]
            # Current Pingora uses this unmaintained compile-time macro for
            # Debug derivation. This exact disposition is recorded in #135 and
            # notes/architecture.md. It is printed, never filtered from audit.
            if not (category == warning["kind"] == advisory["informational"] == "unmaintained"
                    and advisory["id"] == "RUSTSEC-2024-0388"
                    and package["name"] == advisory["package"] == "derivative"
                    and package["version"] == "2.2.0" and package["checksum"] == CHECKSUM):
                raise ValueError("undispositioned advisory")
            matching = [entry for entry in packages.values() if entry["name"] == "derivative" and entry["version"] == "2.2.0"]
            if len(matching) != 1 or [target["kind"] for target in matching[0]["targets"]
                                      if target["kind"] not in (["test"], ["bench"], ["example"])] != [["proc-macro"]]:
                raise ValueError("dependency build scope changed")
            parents = [packages[node["id"]] for node in metadata["resolve"]["nodes"]
                       if any(dependency["pkg"] == matching[0]["id"] for dependency in node["deps"])]
            if len(parents) != 1 or parents[0]["name"] != "pingora-core" or parents[0]["version"] != "0.9.0":
                raise ValueError("dependency path changed")


def main():
    root = Path(__file__).resolve().parent.parent
    cargo = os.environ.get("CARGO", "cargo")
    scanner = os.environ.get("CARGO_AUDIT", "cargo-audit")
    command = [scanner, "audit", "--deny", "unsound", "--deny", "yanked", "--format", "json"]
    if os.environ.get("ELSE_ADVISORY_DATABASE"):
        command += ["--db", os.environ["ELSE_ADVISORY_DATABASE"]]
    scanned = subprocess.run(command, cwd=root, capture_output=True, text=True)
    if scanned.returncode or scanned.stderr.strip():
        raise ValueError("advisory scanner or registry failed")
    report = json.loads(scanned.stdout)
    print(f"RustSec database {report['database']['last-commit']}: {report['database']['advisory-count']} advisories; {report['vulnerabilities']['count']} vulnerabilities.")
    for warnings in report["warnings"].values():
        for warning in warnings:
            print(f"{warning['advisory']['id']}: {warning['package']['name']} {warning['package']['version']} — {warning['advisory']['title']}")
    metadata = json.loads(subprocess.run([cargo, "metadata", "--locked", "--format-version", "1"], cwd=root, check=True, capture_output=True, text=True).stdout)
    assess(report, metadata)
    print("Rust advisory gate passed; the exact Pingora build-macro maintenance disposition remains visible.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("Rust advisory gate failed. Review scanner diagnostics, vulnerabilities or changed advisory/dependency scope.", file=sys.stderr)
        sys.exit(1)
