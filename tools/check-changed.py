#!/usr/bin/env python3
"""Local impact checks; CI and make check remain the complete release gates."""
import argparse
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="HEAD", help="Git baseline; default includes staged and unstaged work")
    args = parser.parse_args()
    tracked = subprocess.check_output(["git", "diff", "--name-only", "-z", args.base, "--"], cwd=ROOT)
    new = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=ROOT)
    paths = sorted({p.decode() for p in (tracked + new).split(b"\0") if p})
    frontend = [p for p in paths if p.startswith("frontend/")]
    if frontend:
        npm = os.environ.get("NPM", "npm")
        run([npm, "run", "typecheck"], ROOT / "frontend")
        run([npm, "run", "lint"], ROOT / "frontend")
        # Shared setup/build/catalog changes can alter the entire test graph.
        shared = any(p.startswith(("frontend/src/app/", "frontend/src/test/", "frontend/src/i18n/", "frontend/src/features/auth/", "frontend/src/components/")) or not p.startswith("frontend/src/") for p in frontend)
        sources = [p.removeprefix("frontend/") for p in frontend if p.endswith((".ts", ".tsx")) and (ROOT / p).is_file()]
        if shared:
            run([npm, "test"], ROOT / "frontend")
        elif sources:
            run([npm, "exec", "--", "vitest", "related", "--run", *sources], ROOT / "frontend")
    if any(p.startswith("backend/") or p in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml") for p in paths):
        cargo = os.environ.get("CARGO", "cargo")
        run([cargo, "fmt", "--all", "--check"])
        run([cargo, "clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"])
        run([cargo, "test", "--locked", "--workspace"])
    print("Changed-source checks completed. Image, browser, migration and security release gates remain separate.")


if __name__ == "__main__":
    main()
