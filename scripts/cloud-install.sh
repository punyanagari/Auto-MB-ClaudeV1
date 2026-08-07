#!/usr/bin/env bash
# Cloud-agent environment install: runs during environment builds, and its
# result is baked into the boot snapshot. Must stay idempotent; any failure
# fails the build.
set -euo pipefail

corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm install --frozen-lockfile
