"""Export one exact registry digest for the already-tested application image."""
import json
from pathlib import Path
import re
import sys


def main():
    if len(sys.argv) != 3:
        raise ValueError()
    image, output = sys.argv[1:]
    if not re.fullmatch(r"ghcr\.io/[a-z0-9][a-z0-9-]*/[a-z0-9_][a-z0-9_.-]*", image):
        raise ValueError()
    raw = sys.stdin.read(8193)
    if len(raw) > 8192:
        raise ValueError()
    values = json.loads(raw)
    if not isinstance(values, list) or len(values) > 32:
        raise ValueError()
    digests = {value[len(image) + 1:] for value in values
               if isinstance(value, str) and re.fullmatch(re.escape(image) + r"@sha256:[0-9a-f]{64}", value)}
    if len(digests) != 1:
        raise ValueError()
    with Path(output).open("a") as stream:
        stream.write(f"image={image}\ndigest={digests.pop()}\n")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, TypeError):
        sys.exit("Published image digest is unavailable or invalid.")
