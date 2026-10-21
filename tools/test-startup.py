#!/usr/bin/env python3
"""Exercise redacted startup stages on owned synthetic volume metadata/bytes."""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import uuid

DATA = "/var/lib/roisey-else"


def docker(*args, **options):
    return subprocess.run([os.environ.get("DOCKER", "docker"), *args], check=True, **options)


def run(image):
    results = []
    relay_cases = ("relay_credentials", "relay_destination", "relay_plaintext")
    for case in ("ownership", "control_readonly", "database", "keyring", "frontend", "smtp_configuration", "otp_policy", "https_cookies", *relay_cases):
        identity = "else-startup-test-" + uuid.uuid4().hex
        created_volume = created_container = False
        try:
            docker("volume", "create", "--label", "roisey.else.test=startup", identity, stdout=subprocess.DEVNULL)
            created_volume = True
            if case == "ownership":
                artifact = json.loads((Path(__file__).resolve().parents[1] / "build/redis-artifact.json").read_text())["image"]
                # Nonroot one-shot fixture creates nonempty differently owned
                # storage. No service runs and no customer volume is selected.
                docker("run", "--rm", "--name", identity + "-seed", "--network", "none", "--user", "999:999", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--mount", f"type=volume,src={identity},dst=/data", "--entrypoint", "/bin/sh", artifact, "-ec", "chmod 0700 /data\nprintf synthetic > /data/synthetic-marker", stdout=subprocess.DEVNULL, timeout=10)
            args = ["--name", identity, "-e", "AUTH_PUBLIC_ORIGIN=http://127.0.0.1:8080", "-e", "AUTH_COOKIE_SECURE=false", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--mount", f"type=volume,src={identity},dst={DATA}" + (",readonly" if case == "control_readonly" else "")]
            if case == "https_cookies":
                args += ["-e","AUTH_PUBLIC_ORIGIN=https://signin.example.com"]
            if case == "smtp_configuration":
                args += ["-e","SMTP_HOST=smtp.example.com","-e","SMTP_SECURITY=none"]
            if case in relay_cases:
                values={"SMTP_AUTH_MODE":"trusted_relay","SMTP_HOST":"mail.example.test","SMTP_PORT":"10025","SMTP_FROM_ADDRESS":"noreply@example.test","SMTP_RELAY_IP":"10.203.41.2","SMTP_SECURITY":"starttls"}
                if case=="relay_credentials": values["SMTP_USERNAME"]="synthetic-unexpected"
                if case=="relay_destination": values["SMTP_RELAY_IP"]="8.8.8.8"
                if case=="relay_plaintext": values["SMTP_SECURITY"]="none"
                args += [item for key,value in values.items() for item in ("-e",key+"="+value)]
            if case == "otp_policy":
                args += ["-e","AUTH_OTP_LIFETIME_SECONDS=0"]
            if case == "frontend":
                args += ["-e", "FRONTEND_DIRECTORY=/synthetic-missing-frontend"]
            docker("create", *args, image, stdout=subprocess.DEVNULL)
            created_container = True
            if case in ("database", "keyring"):
                archive = io.BytesIO()
                owner = 999 if case == "ownership" else 65532
                with tarfile.open(fileobj=archive, mode="w") as files:
                    for directory in ([".", ".control"] if case == "keyring" else ["."]):
                        entry = tarfile.TarInfo(directory)
                        entry.type = tarfile.DIRTYPE
                        entry.mode = 0o700
                        entry.uid = entry.gid = owner
                        files.addfile(entry)
                    filename, content = {
                        "ownership": ("synthetic-marker", b"synthetic preserved volume"),
                        "database": ("else.sqlite3", b"synthetic invalid SQLite"),
                        "keyring": (".control/integration-keyring.json", b"synthetic invalid keyring"),
                    }[case]
                    entry = tarfile.TarInfo(filename)
                    entry.size = len(content)
                    entry.mode = 0o400 if case == "keyring" else 0o600
                    entry.uid = entry.gid = owner
                    files.addfile(entry, io.BytesIO(content))
                docker("cp", "--archive", "-", identity + ":" + DATA, input=archive.getvalue(), stdout=subprocess.DEVNULL)
            docker("start", identity, stdout=subprocess.DEVNULL)
            exit_code = docker("wait", identity, capture_output=True, text=True, timeout=15).stdout.strip()
            assert exit_code == "1", f"{case} must refuse startup nonzero"
            logs = docker("logs", identity, capture_output=True, text=True)
            fields = [json.loads(line)["fields"] for line in (logs.stdout + logs.stderr).splitlines() if line.startswith('{')]
            failure = next(row for row in fields if row["message"] == "application_startup_failed")
            assert failure["error_code"] != "internal_error"
            expected = {"ownership": "storage", "control_readonly": "control", "database": "database", "keyring": "keyring", "frontend": "frontend", "smtp_configuration":"configuration", "otp_policy":"configuration", "https_cookies":"configuration"}
            expected.update({case:"configuration" for case in relay_cases})
            assert failure["stage"] == expected[case], f"Incorrect startup stage: {failure}"
            if case == "ownership":
                assert failure["owner_uid"] == 999 and failure["runtime_uid"] == 65532 and failure["directory_mode"] == "0700"
            if case == "control_readonly":
                assert failure["operation"] == "create_directory" and failure["errno"] == 30
            if case in ("database", "keyring", "frontend"):
                assert any(row["message"] == "embedded_redis_stopped" for row in fields), "Startup failure must stop/reap its child"
            if case in ("smtp_configuration","otp_policy","https_cookies",*relay_cases):
                assert not any(row["message"]=="embedded_redis_starting" for row in fields), "Unsafe authentication config must fail before starting dependencies"
            assert all(value not in (logs.stdout + logs.stderr) for value in ("synthetic invalid", "synthetic-marker", "synthetic-missing-frontend", "integration-keyring.json"))
            results.append({"case": case, "exit_code": 1, "diagnostic": failure})
        finally:
            if created_container:
                docker("rm", "--force", identity, stdout=subprocess.DEVNULL)
            if created_volume:
                docker("volume", "rm", identity, stdout=subprocess.DEVNULL)
    print(json.dumps({"startup_failure_checks": results}, sort_keys=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="else-application:ci")
    run(parser.parse_args().image)
