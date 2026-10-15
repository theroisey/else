#!/usr/bin/env python3
"""Reject vulnerabilities and undispositioned advisories; keep findings visible."""
import json
import os
from pathlib import Path
import subprocess
import sys

CHECKSUM = "fcc3dd5e9e9c0b295d6e1e4d811fb6f157d5ffd784b8d202fc62eac8035a770b"
YAML_CHECKSUM = "673aac59facbab8a9007c7f6108d11f63b603f7cabff99fabf650fea5c32b861"


def findings(report):
    print(f"RustSec database {report['database']['last-commit']}: {report['database']['advisory-count']} advisories; {report['vulnerabilities']['count']} vulnerabilities.")
    entries = list(report["vulnerabilities"]["list"])
    for warnings in report["warnings"].values():
        entries.extend(warnings)
    for entry in entries:
        advisory = entry.get("advisory") or {}
        package = entry["package"]
        message = f"{advisory.get('id', entry.get('kind', 'registry finding'))}: {package['name']} {package['version']} — {advisory.get('title', 'Registry finding')}"
        print("".join(character for character in message if character.isprintable()))


def assess(report, metadata):
    if report["database"]["advisory-count"] < 1 or not report["database"]["last-commit"]:
        raise ValueError("empty advisory database")
    vulnerabilities = report["vulnerabilities"]
    if vulnerabilities["found"] or vulnerabilities["count"] or vulnerabilities["list"]:
        raise ValueError("vulnerable dependency")
    packages = {package["id"]: package for package in metadata["packages"]}
    def sole_parent(package, name, version):
        parents = [packages[node["id"]] for node in metadata["resolve"]["nodes"]
                   if any(dependency["pkg"] == package["id"] for dependency in node["deps"])]
        if len(parents) != 1 or (parents[0]["name"], parents[0]["version"]) != (name, version):
            raise ValueError("dependency path changed")
        return parents[0]

    for category, warnings in report["warnings"].items():
        for warning in warnings:
            package, advisory = warning["package"], warning["advisory"]
            if category == warning["kind"] == advisory["informational"] == "unmaintained" and (
                    advisory["id"], package["name"], advisory["package"], package["version"], package["checksum"]
            ) == ("RUSTSEC-2024-0449", "unsafe-libyaml", "unsafe-libyaml", "0.2.11", YAML_CHECKSUM):
                # Pingora's mandatory YAML dependency is compiled but receives
                # no input: this application supplies ServerConf directly through
                # new_with_opt_and_conf(None, conf), without its YAML/CLI loader.
                # Keep this maintenance finding visible and bind both parents;
                # vulnerabilities/unsound/yanked findings are never dispositioned.
                matching = [entry for entry in packages.values() if entry["name"] == "unsafe-libyaml" and entry["version"] == "0.2.11"]
                if len(matching) != 1:
                    raise ValueError("dependency scope changed")
                yaml = sole_parent(matching[0], "serde_yaml", "0.9.34+deprecated")
                sole_parent(yaml, "pingora-core", "0.9.0")
                continue
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
            sole_parent(matching[0], "pingora-core", "0.9.0")


def main():
    root = Path(__file__).resolve().parent.parent
    cargo = os.environ.get("CARGO", "cargo")
    scanner = os.environ.get("CARGO_AUDIT", "cargo-audit")
    command = [scanner, "audit", "--deny", "unsound", "--deny", "yanked", "--format", "json"]
    if os.environ.get("ELSE_ADVISORY_DATABASE"):
        command += ["--db", os.environ["ELSE_ADVISORY_DATABASE"]]
    scanned = subprocess.run(command, cwd=root, capture_output=True, text=True)
    if scanned.returncode or scanned.stderr.strip():
        # A vulnerability makes the real scanner exit nonzero. Preserve its
        # public advisory findings while never printing raw registry diagnostics
        # that could contain host credentials or private registry addresses.
        try:
            findings(json.loads(scanned.stdout))
        except (ValueError, KeyError, TypeError):
            print("Scanner returned no valid advisory report.")
        print(f"Scanner exit status: {scanned.returncode}; registry diagnostics present: {bool(scanned.stderr.strip())}.")
        raise ValueError("advisory scanner or registry failed")
    report = json.loads(scanned.stdout)
    findings(report)
    metadata = json.loads(subprocess.run([cargo, "metadata", "--locked", "--format-version", "1"], cwd=root, check=True, capture_output=True, text=True).stdout)
    assess(report, metadata)
    print("Rust advisory gate passed; exact Pingora macro and unused configuration-parser maintenance dispositions remain visible.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("Rust advisory gate failed. Review scanner diagnostics, vulnerabilities or changed advisory/dependency scope.", file=sys.stderr)
        sys.exit(1)
