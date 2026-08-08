# Dependency policy

Dependencies are adopted only when they replace meaningful commodity work and have a narrow boundary.

## Foundation dependencies

| Capability    | Dependency               | Why                                                                                                                                  |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Web           | React + Vite             | Small, conventional SPA surface                                                                                                      |
| API           | Fastify                  | JSON Schema validation, logging, low overhead                                                                                        |
| Contracts     | TypeBox                  | One definition for runtime validation, TS types, and OpenAPI                                                                         |
| Database      | PostgreSQL + postgres.js | Transactions, RLS, constraints, simple operational model                                                                             |
| Typed queries | Drizzle ORM              | Adopt when the first module queries land; SQL remains visible                                                                        |
| Testing       | Vitest                   | Shared TypeScript test runner                                                                                                        |
| PDF service   | Gotenberg                | Isolated, repeatable Chromium rendering                                                                                              |
| PDF text      | poppler-utils            | `pdftotext -layout` — the exact extraction the LOA parser corpus was built with; system binary, argument-vector invocation, no shell |

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

## Explicit non-defaults

Redis, Kafka, Temporal, Kubernetes, OpenSearch, a policy engine, and enterprise IdP are not installed until a measured requirement exceeds the simpler stack.

## Versioning

- application and production dependencies are exact-pinned;
- the committed lockfile is authoritative; CI installs with `--frozen-lockfile`;
- dependency updates arrive through reviewed PRs;
- security upgrades may bypass the normal schedule but still require tests.
