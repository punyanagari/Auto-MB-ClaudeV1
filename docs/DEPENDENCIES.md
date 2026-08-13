# Dependency policy

Dependencies are adopted only when they replace meaningful commodity work and have a narrow boundary.

## Foundation dependencies

| Capability  | Dependency               | Why                                                                                                                                                                                                                             |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web         | React + Vite             | Small, conventional SPA surface                                                                                                                                                                                                 |
| API         | Fastify                  | JSON Schema validation, logging, low overhead                                                                                                                                                                                   |
| Contracts   | TypeBox                  | One definition for runtime validation, TS types, and OpenAPI                                                                                                                                                                    |
| Database    | PostgreSQL + postgres.js | Transactions, RLS, constraints, simple operational model                                                                                                                                                                        |
| SQL access  | postgres.js              | Parameterised SQL remains visible; organisation-scoped transaction helpers enforce tenant context                                                                                                                               |
| Testing     | Vitest                   | Shared TypeScript test runner                                                                                                                                                                                                   |
| PDF service | Gotenberg                | Isolated, repeatable Chromium rendering                                                                                                                                                                                         |
| PDF text    | poppler-utils            | Parallel `pdftotext -layout` + `-raw`: layout-authoritative fields and exact item-description ownership; system binary, argument-vector invocation, no shell. **Poppler specifically** — verified at extraction time, see below |
| Invoice QR  | qrcode                   | Standards-compliant SVG encoding of the exact IRP signed-QR payload for a self-contained tax-invoice PDF                                                                                                                        |

## Adopt with the relevant milestone

| Dependency     | Trigger                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------- |
| pg-boss        | First asynchronous extraction/PDF job                                                           |
| Testcontainers | Only if the compose/CI-service model for database tests becomes insufficient (it is in use now) |
| OpenTelemetry  | A real telemetry backend exists (until then: the hand-rolled `/metrics` endpoint, zero deps)    |
| k6             | Published capacity benchmark                                                                    |
| OpenTofu       | AWS staging infrastructure                                                                      |
| Trivy/ZAP      | Container scan at first application image; DAST at staging                                      |

Already adopted: Renovate (pin strategy with cooldown), secretlint (secret scan in `pnpm verify`), eslint-plugin-security (static security lint), Better Auth + node-postgres (identity; the `pg` pool serves Better Auth only, the application keeps postgres.js), Semgrep (pinned, CI SAST job), Playwright + axe + Testing Library + jsdom (browser accessibility smoke and component tests, adopted with the first UI workflow), ClamAV (upload scanning as a service container; the clamd INSTREAM client is ~80 lines of stdlib, deliberately not an npm package), Caddy (production TLS termination and static serving, deploy/ only).

The Whitebooks adapter uses platform HTTP and cryptography APIs and translates
provider schemas only at the server boundary rather than leaking them into
domain tables or browser contracts.

## `pdftotext` must be Poppler's

The LOA parser and its regression corpus are calibrated against Poppler's
`pdftotext -layout` column geometry. **Xpdf ships a binary with the same name
and the same `-layout` / `-raw` flags**, so an argument-vector invocation of
bare `pdftotext` succeeds against it and returns text that looks plausible but
is shaped differently — on a real IREPS letter (PL281-BB) it yielded a null
unit column on 42 of 54 item rows and mis-owned descriptions, i.e. silently
wrong values for the quantities and rates every downstream figure derives
from.

`apps/server/src/loa-extract.ts` therefore probes the binary's `-v` banner
once per process and refuses to extract unless it is Poppler's. The probe
reads both stdout and stderr and ignores the exit status, because the two
implementations disagree on both: Poppler writes the banner to stderr and
exits 0, Xpdf writes it to stdout and exits 99.

Operational notes:

- CI (`.github/workflows/ci.yml`) and the server image
  (`deploy/Dockerfile.server`) install `poppler-utils`, which satisfies this.
- On a developer machine where another toolchain shadows Poppler on `PATH`
  (Git-for-Windows/MSYS2 ships Xpdf at `/mingw64/bin/pdftotext`), set
  `AUTO_MB_PDFTOTEXT` to the full path of Poppler's `pdftotext`.
- A failed probe is not cached, so correcting the environment and retrying
  works without restarting the server.

## PDF digital-signature verification adds no dependency

`apps/server/src/pdf-signature/` reads PDF signature dictionaries and CMS
SignedData blobs with about 900 lines of hand-written DER and PDF parsing,
and does no cryptography of its own: digests, RSA PKCS#1 v1.5, RSASSA-PSS,
ECDSA verification, X.509 parsing and issuer-link checking are all
`node:crypto`, i.e. OpenSSL.

The 2026 survey behind the decision (recorded in the pull request) found
that the well-regarded option is `pkijs` + `@peculiar/x509` + a
hand-written PDF revision reader — that is, the parsing work is
unavoidable either way, and what a dependency would replace is the CMS
structure walk. Under this repository's rule (adopted only when they
replace meaningful commodity work AND have a narrow boundary), that is not
enough to put third-party code on the path of a security verdict.

The survey also disqualified the obvious candidate outright:
`node-forge` shipped fixes in March/April 2026 for an RSA PKCS#1 v1.5
signature FORGERY (CVE-2026-33894) and a `verifyCertificateChain`
basicConstraints bypass (CVE-2026-33896) — precisely the two functions a
verifier would have depended on. The convenience wrappers
(`@ninja-labs/verify-pdf`, `pdf-signature-reader` and their forks) are
abandoned, built on forge, and validate against the chain EMBEDDED IN THE
DOCUMENT, which proves nothing. `mupdf` is capable and actively released
but AGPL-3.0-or-later, which is a real obligation for a hosted service.

Trust anchors are operator-supplied PEM files, never compiled in; the
sourcing and refresh procedure is docs/OPERATIONS.md §8.

## Explicit non-defaults

Redis, Kafka, Temporal, Kubernetes, OpenSearch, a policy engine, and enterprise IdP are not installed until a measured requirement exceeds the simpler stack.

## Versioning

- application and production dependencies are exact-pinned;
- the committed lockfile is authoritative; CI installs with `--frozen-lockfile`;
- dependency updates arrive through reviewed PRs;
- security upgrades may bypass the normal schedule but still require tests.
