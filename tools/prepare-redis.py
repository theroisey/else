#!/usr/bin/env python3
"""Prepare only the pinned Redis executable, ELF dependency closure and notices."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "redis:8.2.3-alpine@sha256:08ad0b1d280850169a790dba1393ff7a90aef951fc19632cf4d3ce4f78e679ba"
SOURCE = "https://codeload.github.com/redis/redis/tar.gz/refs/tags/8.2.3"
SOURCE_SHA256 = "42d4d3f037db92eea4437ba03f87627cd636ed15a1f2dde7af9650aa94b035d8"
LIBRARIES = {
    "/lib/ld-musl-x86_64.so.1",
    "/usr/lib/libstdc++.so.6",
    "/usr/lib/libgcc_s.so.1",
    "/usr/lib/libssl.so.3",
    "/usr/lib/libcrypto.so.3",
}
NOTICE_HASHES = {
    "OpenSSL-LICENSE.txt": "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a",
    "GCC-COPYING3.txt": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
    "GCC-RUNTIME.txt": "9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74",
    "GCC-COPYING.LIB.txt": "a9bdde5616ecdd1e980b44f360600ee8783b1f99b8cc83a2beb163a0a390e861",
    "musl-COPYRIGHT.txt": "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
}


def docker(*arguments, **options):
    return subprocess.run([os.environ.get("DOCKER", "docker"), *arguments], check=True, **options)


def run():
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    build.chmod(0o755)
    runtime = build / "redis-runtime"
    if runtime.is_symlink():
        raise SystemExit("Runtime artifacts must not be symlinks.")
    docker("pull", "--platform", "linux/amd64", IMAGE, stdout=subprocess.DEVNULL)
    metadata = json.loads(docker("image", "inspect", IMAGE, capture_output=True, text=True).stdout)[0]
    if (metadata["Os"], metadata["Architecture"]) != ("linux", "amd64"):
        raise SystemExit("Redis artifact platform must be Linux AMD64.")
    name = "else-redis-artifact-" + uuid.uuid4().hex
    docker("create", "--name", name, IMAGE, stdout=subprocess.DEVNULL)
    try:
        if runtime.exists():
            shutil.rmtree(runtime)
        runtime.mkdir(mode=0o755)
        binary = build / "redis-server"
        binary.unlink(missing_ok=True)
        docker("cp", "-L", name + ":/usr/local/bin/redis-server", str(binary))
        binary.chmod(0o755)
        subprocess.run(["strip", "--strip-unneeded", str(binary)], check=True)
        binary.chmod(0o555)
        for source in sorted(LIBRARIES):
            destination = runtime / source.lstrip("/")
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            docker("cp", "-L", name + ":" + source, str(destination))
            destination.chmod(0o555)
        (runtime / "lib/libc.musl-x86_64.so.1").symlink_to("ld-musl-x86_64.so.1")
        (runtime / "tmp").mkdir(mode=0o1777)
        for directory in [runtime, *[p for p in runtime.rglob("*") if p.is_dir()]]:
            directory.chmod(0o755)
        (runtime / "tmp").chmod(0o1777)
        available = {path.name for path in runtime.rglob("*") if path.is_file()}
        for artifact in [binary, *[runtime / source.lstrip("/") for source in LIBRARIES]]:
            elf = subprocess.run(["readelf", "-d", str(artifact)], capture_output=True, text=True, check=True).stdout
            needed = set(re.findall(r"\(NEEDED\).*\[([^\]]+)\]", elf))
            if not needed <= available:
                raise SystemExit("Redis ELF dependency closure changed; review the pinned artifact.")
        version = subprocess.run([str(runtime / "lib/ld-musl-x86_64.so.1"), "--library-path", f"{runtime / 'lib'}:{runtime / 'usr/lib'}", str(binary), "--version"], check=True, capture_output=True, text=True).stdout
        if not re.search(r"\bv=8\.2\.3\b", version):
            raise SystemExit("Redis artifact version changed.")
    finally:
        docker("rm", name, stdout=subprocess.DEVNULL)
    licenses = build / "licenses"
    licenses.mkdir(exist_ok=True)
    licenses.chmod(0o755)
    for name, digest in NOTICE_HASHES.items():
        source = ROOT / "tools/redis-licenses" / name
        if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            raise SystemExit("Redis dependency notice changed.")
        shutil.copyfile(source, licenses / name)
        (licenses / name).chmod(0o644)
    with urllib.request.urlopen(SOURCE, timeout=30) as response:
        source = response.read(20 * 1024 * 1024 + 1)
    if len(source) > 20 * 1024 * 1024 or hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise SystemExit("Pinned Redis source checksum changed.")
    with tempfile.TemporaryFile() as archive:
        archive.write(source)
        archive.seek(0)
        texts = [f"Redis 8.2.3 runtime artifact (debug symbols stripped): {IMAGE}\nCorresponding Redis source: {SOURCE}\nSource SHA256: {SOURCE_SHA256}\nRuntime libraries: musl 1.2.5-r10; GCC 14.2.0-r6; OpenSSL 3.5.5-r0.\nGCC runtime libraries retain their runtime exception and original notices.\nCorresponding package recipes: https://github.com/alpinelinux/aports/tree/1a5f5e699b2eae883e73c93a789f87bd89a2a190/main/musl; https://github.com/alpinelinux/aports/tree/fbf60319be3bbaf6dd32ef55cc6fb7189e05c266/main/gcc; https://github.com/alpinelinux/aports/tree/fc80347242e697b34047cdd5418417845460e034/main/openssl\nThese notices do not grant a license to the Roisey Else application.\n"]
        with tarfile.open(fileobj=archive) as files:
            for member in sorted(files.getmembers(), key=lambda item: item.name):
                leaf = Path(member.name).name.lower()
                if member.isfile() and (leaf.startswith(("license", "copying", "copyright", "notice")) or leaf == "rediscontributions.txt"):
                    if member.size > 256 * 1024:
                        raise SystemExit("Unexpected Redis license file.")
                    texts.append("\n" + member.name + "\n" + files.extractfile(member).read().decode())
        (licenses / "Redis-notices.txt").write_text("\n".join(texts))
        (licenses / "Redis-notices.txt").chmod(0o644)
    record = {"image": IMAGE, "source_sha256": SOURCE_SHA256, "artifacts": {str(p.relative_to(build)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [build / "redis-server", *[runtime / source.lstrip('/') for source in sorted(LIBRARIES)]]}}
    (build / "redis-artifact.json").write_text(json.dumps(record, sort_keys=True, indent=2) + "\n")
    print(json.dumps({"redis_version": "8.2.3", "runtime_bytes": sum(path.stat().st_size for path in [binary, *[runtime / source.lstrip('/') for source in LIBRARIES]]), "shared_libraries": len(LIBRARIES), "image": IMAGE}, sort_keys=True))


if __name__ == "__main__":
    run()
