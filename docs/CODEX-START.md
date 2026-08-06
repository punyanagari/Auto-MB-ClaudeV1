# First Codex mission

Use this after the repository is created and the dependency lockfile is committed.

```text
Read AGENTS.md and the five authoritative documents under docs/.

Mission: complete Milestone 0 only. Do not implement authentication, LOA upload,
Delivery Challans, or speculative infrastructure yet.

1. Install dependencies and generate a committed pnpm-lock.yaml.
2. Run the current verification suite and fix only foundation defects.
3. Start PostgreSQL and Gotenberg with Docker Compose.
4. Apply the migrations using the admin connection.
5. Start web, server, and worker.
6. Verify /api/health, /api/ready, Swagger UI, and the web health indicator.
7. Add a real PostgreSQL integration test that proves:
   - the application role is not superuser and cannot bypass RLS;
   - Organisation A cannot select or mutate Organisation B's Work;
   - a membership can be listed by its own user before organisation selection;
   - audit_events cannot be updated or deleted by the application role.
8. Add exact commands and results to the pull request.

Constraints:
- Preserve the imported LOA parser behaviour and fixtures.
- Do not add Codev, another model, a custom agent hierarchy, Redis, Kafka,
  Kubernetes, or a new framework.
- Do not weaken RLS to make tests pass.
- Do not claim STQC compliance.
```
