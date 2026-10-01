"""Sanitize diagnostics from the verifier's generated, isolated credentials."""
from pathlib import Path
import re
import sys

credentials = []
for line in Path(sys.argv[1]).read_text().splitlines():
    name, separator, value = line.partition("=")
    if separator and name.endswith("PASSWORD") and value:
        credentials.append(value)
for line in sys.stdin:
    for credential in credentials:
        line = line.replace(credential, "<redacted>")
    line = re.sub(r"postgres(?:ql)?://[^\s]+", "<redacted-database-url>", line)
    sys.stdout.write(line)
