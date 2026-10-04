"""Exercise the recovery shell helper without Docker, credentials, or sleeping."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("recover-compose.sh")
PROBE = ["exec", "-T", "else", "/healthcheck"]


class RecoveryTests(unittest.TestCase):
    def execute(self, failures=0, start_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trace = root / "calls.jsonl"
            mock = root / "mock"
            mock.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
trace = Path(os.environ['TEST_TRACE'])
calls = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
args = sys.argv[1:]
with trace.open('a') as output:
    output.write(json.dumps(args) + '\\n')
print('synthetic-private-diagnostic')
print('synthetic-private-diagnostic', file=sys.stderr)
if args == ['compose', 'start', 'else']:
    sys.exit(int(os.environ['TEST_START_FAILS']))
if args[:4] == ['compose', 'exec', '-T', 'else']:
    probes = sum(call[:2] == ['compose', 'exec'] for call in calls)
    sys.exit(1 if probes < int(os.environ['TEST_FAILURES']) else 0)
if args == ['sleep', '1']:
    sys.exit(0)
sys.exit(99)
""")
            mock.chmod(0o755)
            result = subprocess.run(
                ["sh", "-c", """
set -eu
compose() { "$TEST_MOCK" compose "$@"; }
sleep() { "$TEST_MOCK" sleep "$@" >/dev/null 2>&1; }
. "$TEST_SCRIPT"
recover_compose_else
"""],
                env={**os.environ, "TEST_TRACE": str(trace), "TEST_MOCK": str(mock),
                     "TEST_SCRIPT": str(SCRIPT), "TEST_FAILURES": str(failures),
                     "TEST_START_FAILS": str(int(start_fails))},
                capture_output=True, text=True, timeout=10,
            )
            calls = [json.loads(line) for line in trace.read_text().splitlines()]
        self.assertEqual(result.stdout, "")
        self.assertNotIn("synthetic-private-diagnostic", result.stderr)
        self.assertEqual(calls[0], ["compose", "start", "else"])
        self.assertEqual(sum(call == calls[0] for call in calls), 1)
        return result, calls

    def test_immediate_readiness_starts_existing_container_then_reads(self):
        result, calls = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(calls, [["compose", "start", "else"], ["compose", *PROBE]])

    def test_delayed_readiness_polls_without_restarting_or_recreating(self):
        result, calls = self.execute(failures=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(calls[1:], [["compose", *PROBE], ["sleep", "1"]] * 3 + [["compose", *PROBE]])

    def test_last_allowed_probe_can_succeed(self):
        result, calls = self.execute(failures=59)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(call == ["compose", *PROBE] for call in calls), 60)
        self.assertEqual(sum(call == ["sleep", "1"] for call in calls), 59)

    def test_permanent_unavailability_fails_after_sixty_probes(self):
        result, calls = self.execute(failures=100)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "Application readiness did not recover.\n")
        self.assertEqual(calls[1:], [["compose", *PROBE], ["sleep", "1"]] * 59 + [["compose", *PROBE]])

    def test_start_failure_stops_before_any_probe(self):
        result, calls = self.execute(start_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "Application recovery start failed.\n")
        self.assertEqual(calls, [["compose", "start", "else"]])


if __name__ == "__main__":
    unittest.main()
