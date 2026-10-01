"""Verify publication boundaries without registry access or credentials."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("publish-images.sh")
REVISION = "a" * 40


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.trace = self.root / "calls.jsonl"
        self.environment = {
            **os.environ,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "push",
            "GITHUB_SHA": REVISION,
            "GITHUB_REPOSITORY": "Example/Else",
            "IMAGE_VERSION": "",
            "TEST_TRACE": str(self.trace),
            "TEST_EXISTING": "[]",
            "PATH": f"{self.root}:{os.environ['PATH']}",
        }
        docker = self.root / "docker"
        docker.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['TEST_TRACE'], 'a') as trace:
    trace.write(json.dumps(args) + '\\n')
if args[:2] == ['manifest', 'inspect']:
    sys.exit(0 if args[-1] in json.loads(os.environ['TEST_EXISTING']) else 1)
if args[:2] == ['image', 'inspect']:
    if args[-1].endswith(':ci'):
        print(os.environ.get('TEST_LOCAL_REVISION', os.environ['GITHUB_SHA']))
    else:
        print(os.environ.get('TEST_REMOTE_REVISION', os.environ['GITHUB_SHA']))
""")
        docker.chmod(0o755)
        gh = self.root / "gh"
        gh.write_text("#!/usr/bin/env python3\nimport os\nprint(os.environ.get('TEST_MAIN_SHA', os.environ['GITHUB_SHA']))\n")
        gh.chmod(0o755)

    def execute(self, *, dry=False, **changes):
        result = subprocess.run(
            ["bash", str(SCRIPT), *(["--print-tags"] if dry else [])],
            env={**self.environment, **changes}, capture_output=True, text=True,
        )
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()] if self.trace.exists() else []
        return result, calls

    def test_pr_tag_and_feature_events_cannot_touch_registry(self):
        for settings in (
            {"GITHUB_EVENT_NAME": "pull_request"},
            {"GITHUB_REF": "refs/heads/backend"},
            {"GITHUB_REF": "refs/tags/v1.2.3"},
        ):
            with self.subTest(settings=settings):
                result, calls = self.execute(**settings)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_version_input_cannot_become_shell_code_or_a_mutable_alias(self):
        for version in ("latest", "v01.2.3", "v1.2.3-rc.1", "v1.2.3; echo forbidden", "v1.2.3\nlatest"):
            with self.subTest(version=version):
                result, calls = self.execute(IMAGE_VERSION=version)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_dry_run_lists_canonical_tags_without_registry_calls(self):
        result, calls = self.execute(dry=True, GITHUB_EVENT_NAME="workflow_dispatch", IMAGE_VERSION="v1.2.3")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 6)
        self.assertIn(f"ghcr.io/example/else-frontend:sha-{REVISION}", result.stdout)
        self.assertIn("ghcr.io/example/else-backend:v1.2.3", result.stdout)
        self.assertEqual(calls, [])

    def test_first_publication_promotes_both_tested_images(self):
        result, calls = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        pushes = [call[-1] for call in calls if call[0] == "push"]
        self.assertEqual(set(pushes), {
            f"ghcr.io/example/else-frontend:sha-{REVISION}",
            f"ghcr.io/example/else-backend:sha-{REVISION}",
            "ghcr.io/example/else-frontend:latest", "ghcr.io/example/else-backend:latest",
        })

    def test_mismatched_image_cannot_be_published(self):
        result, calls = self.execute(TEST_LOCAL_REVISION="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] == "push" for call in calls))

    def test_repeat_promotion_preserves_existing_sha_and_adds_version(self):
        existing = [f"ghcr.io/example/else-{component}:sha-{REVISION}" for component in ("frontend", "backend")]
        result, calls = self.execute(TEST_EXISTING=json.dumps(existing), IMAGE_VERSION="v1.2.3")
        self.assertEqual(result.returncode, 0, result.stderr)
        pushes = [call[-1] for call in calls if call[0] == "push"]
        self.assertFalse(any(":sha-" in ref for ref in pushes))
        self.assertEqual(sum(ref.endswith(":v1.2.3") for ref in pushes), 2)

    def test_old_main_run_cannot_replace_latest(self):
        result, calls = self.execute(TEST_MAIN_SHA="b" * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == "push" and call[-1].endswith(":latest") for call in calls))

    def test_existing_version_for_another_revision_is_refused(self):
        existing = ["ghcr.io/example/else-frontend:v1.2.3"]
        result, calls = self.execute(TEST_EXISTING=json.dumps(existing), TEST_REMOTE_REVISION="b" * 40, IMAGE_VERSION="v1.2.3")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] == "push" and call[-1].endswith(":v1.2.3") for call in calls))


if __name__ == "__main__":
    unittest.main()
