#!/usr/bin/env python3
"""Prepare deterministic static encodings and the minimal runtime's public files."""
import argparse
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def rust_notices():
    metadata = json.loads(subprocess.run(
        [os.environ.get("CARGO", "cargo"), "metadata", "--offline", "--locked", "--format-version", "1", "--filter-platform", "x86_64-unknown-linux-musl"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    notices = ["Third-party Rust dependency notices.\nThese licenses do not grant a license to the Roisey Else application.\n"]
    for package in sorted(metadata["packages"], key=lambda entry: (entry["name"], entry["version"])):
        if package["id"] in metadata["workspace_members"]:
            continue
        directory = Path(package["manifest_path"]).parent
        notices.append(f"\n{package['name']} {package['version']} — {package.get('license') or 'See license text'}\n")
        for path in sorted(directory.rglob("*")):
            if path.is_file() and path.name.lower().startswith(("license", "copying", "notice")):
                if path.is_symlink() or path.stat().st_size > 256 * 1024:
                    raise SystemExit("Unexpected dependency license file.")
                notices.append(f"\n{path.relative_to(directory)}\n" + path.read_text())
    sysroot = Path(subprocess.run(["rustc", "--print", "sysroot"], check=True, capture_output=True, text=True).stdout.strip())
    for name in ("LICENSE-APACHE", "LICENSE-MIT", "COPYRIGHT"):
        source = sysroot / "share/doc/rust" / name
        if source.is_file():
            notices.append(f"\nRust standard library {name}\n" + source.read_text())
    destination = ROOT / "build/licenses/Rust-dependencies.txt"
    destination.write_text("\n".join(notices))
    destination.chmod(0o644)


def frontend():
    dist = ROOT / "frontend/dist"
    if not (dist / "index.html").is_file():
        raise SystemExit("Build the frontend before preparing artifacts.")
    dist.chmod(0o755)
    for path in sorted(dist.rglob("*")):
        if path.is_symlink():
            raise SystemExit("Frontend artifacts must not contain symlinks.")
        path.chmod(0o755 if path.is_dir() else 0o644)
        if path.is_file() and path.suffix in {".html", ".js", ".css", ".svg"}:
            alternate = path.with_name(path.name + ".gz")
            encoded = gzip.compress(path.read_bytes(), compresslevel=9, mtime=0)
            if len(encoded) < path.stat().st_size:
                alternate.write_bytes(encoded)
                alternate.chmod(0o644)
            else:
                alternate.unlink(missing_ok=True)
    licenses = ROOT / "build/licenses"
    licenses.mkdir(parents=True, exist_ok=True)
    licenses.chmod(0o755)
    for name, source in {
        "Manrope-OFL.txt": ROOT / "frontend/node_modules/@fontsource-variable/manrope/LICENSE",
        "Instrument-Serif-OFL.txt": ROOT / "frontend/node_modules/@fontsource/instrument-serif/LICENSE",
    }.items():
        shutil.copyfile(source, licenses / name)
        (licenses / name).chmod(0o644)


def runtime(binary, ca_directory):
    if not binary.is_file():
        raise SystemExit("Build the static Rust release binary first.")
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    shutil.copyfile(binary, build / "roisey-else")
    (build / "roisey-else").chmod(0o755)
    # Use distribution Mozilla roots only; exclude host-local/session proxy CAs.
    roots = sorted(ca_directory.glob("*.crt"))
    if len(roots) < 50 or any(p.is_symlink() or not p.is_file() for p in roots):
        raise SystemExit("Distribution Mozilla CA roots are required.")
    # Replace the previous read-only artifact so repeated make build works.
    certificate = build / "ca-certificates.crt"
    staged_certificate = build / "ca-certificates.crt.tmp"
    staged_certificate.write_bytes(b"\n".join(p.read_bytes() for p in roots))
    staged_certificate.chmod(0o444)
    staged_certificate.replace(certificate)
    for name in ("Manrope-OFL.txt", "Instrument-Serif-OFL.txt"):
        source = build / "licenses" / name
        if source.is_symlink() or not source.is_file():
            raise SystemExit("Prepare frontend artifacts and their licenses first.")
    rust_notices()
    # Copy an explicit child directory's metadata, rather than relying on the
    # destination metadata of an empty-directory COPY. New named volumes must
    # inherit this private mode with the Dockerfile's fixed runtime ownership.
    data_root = build / "data"
    data_root.mkdir(exist_ok=True, mode=0o755)
    data_root.chmod(0o755)
    storage = data_root / "roisey-else"
    storage.mkdir(exist_ok=True, mode=0o700)
    if storage.is_symlink() or any(storage.iterdir()):
        raise SystemExit("Runtime data artifacts must be empty private storage.")
    storage.chmod(0o700)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["frontend", "runtime"])
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--ca-directory", type=Path, default=Path("/usr/share/ca-certificates/mozilla"))
    args = parser.parse_args()
    if args.mode == "frontend":
        frontend()
    elif args.binary is None:
        parser.error("runtime requires --binary")
    else:
        runtime(args.binary.resolve(), args.ca_directory)
