"""Guard dependency publication against vulnerabilities and changed dispositions."""
import copy
import importlib.util
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

    def test_scanner_error_or_registry_diagnostic_cannot_pass(self):
        for result in (subprocess.CompletedProcess([], 1, "{}", ""),
                       subprocess.CompletedProcess([], 0, "{}", "registry lookup failed")):
            with self.subTest(result=result.returncode), patch.object(gate.subprocess, "run", return_value=result):
                with self.assertRaises(ValueError):
                    gate.main()


if __name__ == "__main__":
    unittest.main()
