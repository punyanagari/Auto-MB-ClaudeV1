#!/usr/bin/env bash
# Cloud-agent environment install: runs during environment builds, and its
# result is baked into the boot snapshot. Must stay idempotent; any failure
# fails the build.
set -euo pipefail

# package.json's `packageManager` field pins the exact pnpm version and is
# what corepack reads; naming it again here is a second place to go stale.
corepack enable
pnpm install --frozen-lockfile

# Not every base VM ships Docker (verified: just-in-time boots have no
# docker binary), and a VM can carry docker without the Compose plugin, so
# bake both into the snapshot. cloud-start.sh repeats this check as a
# fallback for boots that never went through a build.
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2
fi

# Cache warming only: pre-pull the compose images into the snapshot when the
# build pod can run a daemon. A miss slows the first boot but breaks
# nothing, so this step warns instead of failing the build. Same direct
# dockerd launch and vfs storage driver as cloud-start.sh (no systemd on
# these pods; nested overlayfs cannot extract every image).
if ! sudo docker info >/dev/null 2>&1; then
  sudo install -d -m 0755 /etc/docker
  printf '{"storage-driver":"vfs"}\n' | sudo tee /etc/docker/daemon.json >/dev/null
  sudo sh -c 'nohup dockerd >/var/log/dockerd.log 2>&1 &'
  for _ in $(seq 1 30); do
    sudo docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
if sudo docker info >/dev/null 2>&1; then
  sudo docker compose pull -q postgres gotenberg ||
    echo "warning: compose image pre-pull failed; images will pull at first boot" >&2
else
  echo "warning: Docker daemon unavailable in the build pod; images will pull at first boot" >&2
fi
