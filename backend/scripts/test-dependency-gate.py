"""Exercise scanner finding/fetch failures without a network or database."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("check-go-vulnerabilities.sh")


class DependencyGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.trace = self.root / "calls.jsonl"
        scanner = self.root / "govulncheck"
        scanner.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
trace = Path(os.environ['TEST_TRACE'])
calls = len(trace.read_text().splitlines()) if trace.exists() else 0
with trace.open('a') as output:
    output.write(json.dumps({'args': sys.argv[1:], 'cwd': os.getcwd()}) + '\\n')
status = json.loads(os.environ['TEST_STATUSES'])[calls]
print('synthetic scan completed' if status == 0 else 'synthetic finding or database failure')
sys.exit(status)
""")
        scanner.chmod(0o755)

    def execute(self, statuses):
        result = subprocess.run(
            ["sh", str(SCRIPT)], cwd=self.root,
            env={**os.environ, "PATH": f"{self.root}:{os.environ['PATH']}",
                 "TEST_TRACE": str(self.trace), "TEST_STATUSES": json.dumps(statuses)},
            capture_output=True, text=True,
        )
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()]
        return result, calls

    def test_clean_result_requires_both_source_configurations_with_tests(self):
        result, calls = self.execute([0, 0])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(Path(call["cwd"]), SCRIPT.resolve().parents[1])
            self.assertIn("-test", call["args"])
            self.assertIn("./...", call["args"])
            self.assertEqual(call["args"][call["args"].index("-format") + 1], "text")
        self.assertNotIn("-tags", calls[0]["args"])
        self.assertEqual(calls[1]["args"][calls[1]["args"].index("-tags") + 1], "integration")

    def test_first_scan_finding_or_fetch_failure_stops_gate(self):
        for status in (1, 2, 3):
            with self.subTest(status=status):
                self.trace.unlink(missing_ok=True)
                result, calls = self.execute([status, 0])
                self.assertEqual(result.returncode, status)
                self.assertEqual(len(calls), 1)

    def test_integration_scan_finding_or_fetch_failure_cannot_be_success(self):
        for status in (1, 2, 3):
            with self.subTest(status=status):
                self.trace.unlink(missing_ok=True)
                result, calls = self.execute([0, status])
                self.assertEqual(result.returncode, status)
                self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
