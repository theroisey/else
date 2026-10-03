#!/bin/sh
# Ordinary text mode preserves govulncheck's finding/error exit status.
# JSON/SARIF/VEX output can exit successfully with vulnerabilities.
set -eu
cd "$(dirname "$0")/.."
govulncheck -format text -show verbose -test ./...
govulncheck -format text -show verbose -test -tags integration ./...
