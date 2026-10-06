#!/usr/bin/env python3
"""Stage an off-host private bundle without root, then invoke empty-volume restore."""
import argparse
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import uuid

DATA = "/var/lib/roisey-else"
FILES = {"database.sqlite3", "keyring.json", "manifest.json"}


def run(source, compose):
    if not source.is_absolute() or source.is_symlink():
        raise SystemExit("BACKUP_SOURCE must be an absolute private bundle directory.")
    metadata = source.stat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_uid not in (os.getuid(), 0):
        raise SystemExit("Backup source directory must be private and owned by the operator.")
    if {p.name for p in source.iterdir()} != FILES:
        raise SystemExit("Backup source must contain exactly the supported bundle files.")
    for name in FILES:
        metadata = (source / name).lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) not in (0o400, 0o600) or metadata.st_uid not in (os.getuid(), 0):
            raise SystemExit("Backup files must be private, singly linked operator-owned regular files.")
    def call(*arguments, **options):
        return subprocess.run([*compose, *arguments], check=True, **options)
    if call("ps", "--status", "running", "--quiet", "else", capture_output=True, text=True).stdout.strip():
        raise SystemExit("Stop the application before attempting offline recovery.")
    identity = "else-recovery-stage-" + uuid.uuid4().hex
    bundle = "backups/" + identity
    docker = compose[0]
    created = False
    try:
        call("run", "--detach", "--no-deps", "--name", identity, "else", "help", stdout=subprocess.DEVNULL)
        created = True
        # Docker's archive API applies explicit ownership, without a root process
        # in the image. Bytes stream directly into private disposable staging;
        # native restore alone decides whether the database may be installed.
        with subprocess.Popen([docker, "cp", "--archive", "-", identity + ":" + DATA], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL) as copying:
            with tarfile.open(fileobj=copying.stdin, mode="w|") as archive:
                for name in ("backups", bundle):
                    entry = tarfile.TarInfo(name)
                    entry.type = tarfile.DIRTYPE
                    entry.uid = entry.gid = 65532
                    entry.mode = 0o700
                    archive.addfile(entry)
                for name in sorted(FILES):
                    descriptor = os.open(source / name, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(descriptor, "rb") as file:
                        metadata = os.fstat(file.fileno())
                        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) not in (0o400, 0o600) or metadata.st_uid not in (os.getuid(), 0):
                            raise SystemExit("Backup source changed during staging.")
                        entry = tarfile.TarInfo(bundle + "/" + name)
                        entry.size = metadata.st_size
                        entry.uid = entry.gid = 65532
                        entry.mode = 0o400 if name == "keyring.json" else 0o600
                        archive.addfile(entry, file)
            copying.stdin.close()
            if copying.wait() != 0:
                raise SystemExit("Backup staging failed; preserve the recovery storage.")
        subprocess.run([docker, "rm", identity], check=True, stdout=subprocess.DEVNULL)
        created = False
        call("run", "--rm", "--no-deps", "-T", "-e", "BACKUP_DIRECTORY=" + DATA + "/" + bundle, "else", "restore")
    finally:
        if created:
            subprocess.run([docker, "rm", "--force", identity], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("compose", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.compose[1:] if args.compose[:1] == ["--"] else args.compose
    if len(command) < 2 or command[1] != "compose":
        parser.error("Supply docker compose after --.")
    run(args.source, command)
