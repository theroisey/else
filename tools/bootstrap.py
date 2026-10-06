#!/usr/bin/env python3
"""Prompt for first-admin credentials without command-line secrets or saved files."""
import getpass
import json
import subprocess
import sys


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "--":
        raise SystemExit("Supply the reviewed bootstrap command after --.")
    if sys.stdin.isatty():
        email = input("Administrator email: ").strip()
        display_name = input("Display name: ").strip()
        password = getpass.getpass("Password (at least 12 characters): ")
        if password != getpass.getpass("Confirm password: "):
            raise SystemExit("Passwords differ; no administrator was created.")
        data = json.dumps({"email": email, "display_name": display_name, "password": password}).encode()
    else:
        data = sys.stdin.buffer.read(4097)
    if len(data) > 4096:
        raise SystemExit("Administrator input exceeds the limit.")
    result = subprocess.run(sys.argv[2:], input=data)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
