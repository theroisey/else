"""Reject unsafe/partial linker values before tool invocation, with fixed errors."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("build-api.sh")
REVISION = "a" * 40


class BuildMetadataTests(unittest.TestCase):
    def test_invalid_stamp_never_invokes_go_or_exposes_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / "called"
            mock = root / "go"
            mock.write_text('#!/bin/sh\ntouch "$TEST_MARKER"\nexit 0\n')
            mock.chmod(0o755)
            good = ["sha-" + REVISION, REVISION, "2026-10-03T18:00:00Z"]
            bad = [[], good[:2], [good[0], "", good[2]], ["synthetic-private-value", *good[1:]],
                   [good[0], "A" * 40, good[2]], ["sha-" + "0" * 40, "0" * 40, good[2]],
                   [*good[:2], "2026-02-30T18:00:00Z"], [*good[:2], "2026-10-03T18:00:00+00:00"],
                   [*good[:2], "1999-01-01T00:00:00Z"], ["$(touch /tmp/synthetic-private-value)", *good[1:]]]
            for values in bad:
                result = subprocess.run(["sh", str(SCRIPT), str(root / "api"), *values],
                    env={**os.environ, "PATH": str(root) + ":" + os.environ["PATH"], "TEST_MARKER": str(marker)},
                    capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, "Invalid API build metadata.\n")
                self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
