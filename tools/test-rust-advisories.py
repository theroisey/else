"""Guard dependency publication against vulnerabilities and changed dispositions."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("check-rust-advisories.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class AdvisoryGateTests(unittest.TestCase):
    def setUp(self):
        self.report = {
            "database": {"advisory-count": 1, "last-commit": "a" * 40},
            "vulnerabilities": {"found": False, "count": 0, "list": []},
            "warnings": {"unmaintained": [{
                "kind": "unmaintained",
                "package": {"name": "derivative", "version": "2.2.0", "checksum": gate.CHECKSUM},
                "advisory": {"id": "RUSTSEC-2024-0388", "informational": "unmaintained", "package": "derivative"},
            }]},
        }
        self.metadata = {
            "packages": [
                {"id": "macro", "name": "derivative", "version": "2.2.0", "targets": [{"kind": ["proc-macro"]}, {"kind": ["test"]}]},
                {"id": "http", "name": "pingora-core", "version": "0.9.0"},
            ],
            "resolve": {"nodes": [{"id": "http", "deps": [{"pkg": "macro"}]}]},
        }

    def test_current_reviewed_build_macro_and_clean_report_pass(self):
        gate.assess(self.report, self.metadata)
        self.report["warnings"] = {}
        gate.assess(self.report, self.metadata)

    def test_empty_advisory_database_cannot_pass(self):
        for field, value in (("advisory-count", 0), ("last-commit", None)):
            with self.subTest(field=field):
                report = copy.deepcopy(self.report)
                report["database"][field] = value
                with self.assertRaises(ValueError):
                    gate.assess(report, self.metadata)

    def test_any_vulnerability_indicator_blocks(self):
        for field, value in (("found", True), ("count", 1), ("list", [{"advisory": "synthetic"}])):
            with self.subTest(field=field):
                report = copy.deepcopy(self.report)
                report["vulnerabilities"][field] = value
                with self.assertRaises(ValueError):
                    gate.assess(report, self.metadata)

    def test_disposition_does_not_allow_new_advisory_or_changed_package(self):
        mutations = (("advisory", "id", "RUSTSEC-2099-0001"), ("advisory", "informational", "unsound"),
                     ("package", "checksum", "0" * 64), ("package", "version", "2.2.1"),
                     ("package", "name", "unreviewed"))
        for section, field, value in mutations:
            with self.subTest(field=field):
                report = copy.deepcopy(self.report)
                report["warnings"]["unmaintained"][0][section][field] = value
                with self.assertRaises(ValueError):
                    gate.assess(report, self.metadata)

    def test_build_macro_cannot_become_runtime_library(self):
        self.metadata["packages"][0]["targets"][0]["kind"] = ["lib"]
        with self.assertRaises(ValueError):
            gate.assess(self.report, self.metadata)

    def test_new_parent_or_pingora_version_requires_review(self):
        for change in ("version", "parent"):
            with self.subTest(change=change):
                metadata = copy.deepcopy(self.metadata)
                if change == "version":
                    metadata["packages"][1]["version"] = "0.10.0"
                else:
                    metadata["packages"].append({"id": "another", "name": "another", "version": "1.0.0"})
                    metadata["resolve"]["nodes"].append({"id": "another", "deps": [{"pkg": "macro"}]})
                with self.assertRaises(ValueError):
                    gate.assess(self.report, metadata)

    def yaml_disposition(self):
        report, metadata = copy.deepcopy(self.report), copy.deepcopy(self.metadata)
        report["warnings"]["unmaintained"].append({
            "kind": "unmaintained",
            "package": {"name": "unsafe-libyaml", "version": "0.2.11", "checksum": gate.YAML_CHECKSUM},
            "advisory": {"id": "RUSTSEC-2024-0449", "informational": "unmaintained", "package": "unsafe-libyaml"},
        })
        metadata["packages"] += [
            {"id": "unsafe", "name": "unsafe-libyaml", "version": "0.2.11"},
            {"id": "yaml", "name": "serde_yaml", "version": "0.9.34+deprecated"},
        ]
        metadata["resolve"]["nodes"][0]["deps"].append({"pkg": "yaml"})
        metadata["resolve"]["nodes"].append({"id": "yaml", "deps": [{"pkg": "unsafe"}]})
        return report, metadata

    def test_unused_yaml_disposition_is_bound_to_both_upstream_parents(self):
        report, metadata = self.yaml_disposition()
        gate.assess(report, metadata)
        for dependency in ("unsafe", "yaml"):
            with self.subTest(dependency=dependency):
                changed = copy.deepcopy(metadata)
                changed["resolve"]["nodes"].append({"id": "macro", "deps": [{"pkg": dependency}]})
                with self.assertRaises(ValueError):
                    gate.assess(report, changed)
        for name in ("serde_yaml", "pingora-core"):
            with self.subTest(package=name):
                changed = copy.deepcopy(metadata)
                next(p for p in changed["packages"] if p["name"] == name)["version"] = "99.0.0"
                with self.assertRaises(ValueError):
                    gate.assess(report, changed)

    def test_yaml_maintenance_review_never_allows_vulnerabilities_or_changed_findings(self):
        for section, key, value in (("package", "checksum", "0" * 64), ("package", "version", "0.2.12"),
                                    ("advisory", "id", "RUSTSEC-2099-0001"), ("advisory", "informational", "unsound")):
            with self.subTest(key=key):
                report, metadata = self.yaml_disposition()
                report["warnings"]["unmaintained"][-1][section][key] = value
                with self.assertRaises(ValueError):
                    gate.assess(report, metadata)
        report, metadata = self.yaml_disposition()
        report["vulnerabilities"]["found"] = True
        with self.assertRaises(ValueError):
            gate.assess(report, metadata)

    def test_scanner_error_or_registry_diagnostic_cannot_pass(self):
        for result in (subprocess.CompletedProcess([], 1, "{}", ""),
                       subprocess.CompletedProcess([], 0, "{}", "registry lookup failed")):
            with self.subTest(result=result.returncode), patch.object(gate.subprocess, "run", return_value=result):
                with self.assertRaises(ValueError):
                    gate.main()

    def test_nonzero_vulnerability_report_remains_visible_without_registry_secrets(self):
        report = copy.deepcopy(self.report)
        report["vulnerabilities"] = {"found": True, "count": 1, "list": [{
            "advisory": {"id": "RUSTSEC-2099-0001", "title": "Synthetic vulnerability"},
            "package": {"name": "synthetic-package", "version": "1.0.0"},
        }]}
        result = subprocess.CompletedProcess([], 1, json.dumps(report), "private-registry-secret")
        output = io.StringIO()
        with patch.object(gate.subprocess, "run", return_value=result), patch("sys.stdout", output):
            with self.assertRaises(ValueError):
                gate.main()
        self.assertIn("RUSTSEC-2099-0001: synthetic-package 1.0.0", output.getvalue())
        self.assertNotIn("private-registry-secret", output.getvalue())


if __name__ == "__main__":
    unittest.main()
