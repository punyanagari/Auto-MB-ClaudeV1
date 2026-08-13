#!/usr/bin/env bash
# Vulnerability scan of the images this deployment actually built.
#
# The reconciled review recorded "no image scanning at all" against the
# supply-chain dimension: the deploy built two images on the production
# host and served them without anything ever looking inside. The deploy
# workflow runs this between BUILD and MIGRATE, so a failing scan stops
# the release while the previous containers are still the ones serving.
#
# Trivy itself runs from a digest-pinned container, so the host needs no
# scanner installed and no scanner self-update path. The vulnerability
# database is cached in a named volume; the host needs outbound HTTPS
# (docs/RUNBOOK.md §1 already assumes it for certificate issuance and
# ClamAV signatures).
#
# Findings are limited to HIGH and CRITICAL WITH A FIX AVAILABLE. An
# unfixable CVE in a base image is not something a deploy can act on, and
# a gate that cannot be satisfied is a gate that gets switched off.
# Accepting a specific fixable finding is a deliberate, reviewable edit to
# deploy/.trivyignore — never a flag on the command line.
set -euo pipefail

TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.73.0@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c}"
TRIVY_SEVERITY="${TRIVY_SEVERITY:-HIGH,CRITICAL}"
TRIVY_TIMEOUT="${TRIVY_TIMEOUT:-15m}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ignore_file="${repo_root}/deploy/.trivyignore"

images=("$@")
if [ "${#images[@]}" -eq 0 ]; then
  images=(auto-mb-prod-server:latest auto-mb-prod-caddy:latest)
fi

status=0
for image in "${images[@]}"; do
  echo "=== trivy: ${image} ==="
  # --ignore-unfixed keeps the gate actionable; --scanners vuln keeps it to
  # packages, since secret and misconfiguration scanning of a built image
  # duplicates gates this repository already runs on the source.
  if ! docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v auto-mb-trivy-cache:/root/.cache/trivy \
    -v "${ignore_file}:/.trivyignore:ro" \
    "${TRIVY_IMAGE}" image \
      --scanners vuln \
      --severity "${TRIVY_SEVERITY}" \
      --ignore-unfixed \
      --ignorefile /.trivyignore \
      --timeout "${TRIVY_TIMEOUT}" \
      --exit-code 1 \
      "${image}"; then
    echo "trivy found fixable ${TRIVY_SEVERITY} vulnerabilities in ${image}" >&2
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "image scan failed; nothing was deployed" >&2
  exit 1
fi
echo "image scan clean: ${images[*]}"
