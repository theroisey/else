#!/usr/bin/env python3
"""Check workflow syntax with the pinned official actionlint Linux binary."""
import hashlib
import io
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

VERSION = "1.7.7"
SHA256 = "023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757"
URL = f"https://github.com/rhysd/actionlint/releases/download/v{VERSION}/actionlint_{VERSION}_linux_amd64.tar.gz"


def main():
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "AMD64"}:
        raise SystemExit("Use official actionlint 1.7.7 for your platform to check .github/workflows/ci.yml.")
    with urllib.request.urlopen(URL, timeout=30) as response:
        archive = response.read(3 * 1024 * 1024 + 1)
    if len(archive) > 3 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != SHA256:
        raise SystemExit("Official actionlint archive checksum verification failed.")
    with tempfile.TemporaryDirectory(prefix="else-actionlint-") as temporary:
        binary = Path(temporary) / "actionlint"
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as files:
            member = files.getmember("actionlint")
            if not member.isfile() or member.size > 20 * 1024 * 1024:
                raise SystemExit("Invalid actionlint executable.")
            binary.write_bytes(files.extractfile(member).read())
        binary.chmod(0o755)
        subprocess.run([str(binary), ".github/workflows/ci.yml"], cwd=Path(__file__).resolve().parent.parent, check=True)


if __name__ == "__main__":
    main()
