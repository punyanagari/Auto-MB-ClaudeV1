# Dependency policy

Dependencies are adopted only when they replace meaningful commodity work and have a narrow boundary.

## Foundation dependencies

| Capability    | Dependency               | Why                                                           |
| ------------- | ------------------------ | ------------------------------------------------------------- |
| Web           | React + Vite             | Small, conventional SPA surface                               |
| API           | Fastify                  | JSON Schema validation, logging, low overhead                 |
| Contracts     | TypeBox                  | One definition for runtime validation, TS types, and OpenAPI  |
| Database      | PostgreSQL + postgres.js | Transactions, RLS, constraints, simple operational model      |
| Typed queries | Drizzle ORM              | Adopt when the first module queries land; SQL remains visible |
| Testing       | Vitest                   | Shared TypeScript test runner                                 |
| PDF service   | Gotenberg                | Isolated, repeatable Chromium rendering                       |

## Adopt with the relevant milestone

| Dependency        | Trigger                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Better Auth       | Identity milestone                                                                              |
| pg-boss           | First asynchronous extraction/PDF job                                                           |
| Testcontainers    | Only if the compose/CI-service model for database tests becomes insufficient (it is in use now) |
| Playwright + axe  | First user workflow UI                                                                          |
| ClamAV            | Upload quarantine before design-partner pilot                                                   |
| OpenTelemetry     | Staging deployment                                                                              |
| k6                | Published capacity benchmark                                                                    |
| OpenTofu          | AWS staging infrastructure                                                                      |
| Semgrep/Trivy/ZAP | Deeper SAST at first authenticated endpoint; container scan at first image; DAST at staging     |

Already adopted: Renovate (pin strategy with cooldown), secretlint (secret scan in `pnpm verify`), eslint-plugin-security (static security lint).

## Explicit non-defaults

Redis, Kafka, Temporal, Kubernetes, OpenSearch, a policy engine, and enterprise IdP are not installed until a measured requirement exceeds the simpler stack.

## Versioning

- application and production dependencies are exact-pinned;
- the committed lockfile is authoritative; CI installs with `--frozen-lockfile`;
- dependency updates arrive through reviewed PRs;
- security upgrades may bypass the normal schedule but still require tests.
