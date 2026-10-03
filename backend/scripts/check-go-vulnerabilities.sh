#!/bin/sh
# Ordinary text mode preserves govulncheck's finding/error exit status.
# JSON/SARIF/VEX output can exit successfully with vulnerabilities.
set -eu
cd "$(dirname "$0")/.."
govulncheck -format text -show verbose -test ./...
govulncheck -format text -show verbose -test -tags integration ./...
# Symbol-level success can still leave an advisory in an unimported package.
# Identify and reject vulnerable modules rather than silently accepting them.
govulncheck -format text -show verbose -scan module ./...
