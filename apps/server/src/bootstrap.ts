import { runDatabaseBootstrap } from '@auto-mb/db/bootstrap';
import { seedTestUser } from './seed-test-user.js';

/**
 * The deployment's database entry point: esbuild bundles this file into
 * the image's compiled bootstrap entry point, which the deploy runs with
 * plain node (deploy/Dockerfile.server, .github/workflows/deploy.yml,
 * docs/RUNBOOK.md §2/§3/§5).
 *
 * It lives in this app rather than in `@auto-mb/db` for one reason: the
 * optional test-user step must create its account through Better Auth,
 * which belongs to the server. The database half is unchanged and still
 * runs first — a failure there exits before any account work is
 * attempted, and before the deploy recreates a single container.
 */
const rolesOnly = process.argv.includes('--roles-only');
await runDatabaseBootstrap({ rolesOnly });

// Roles-only is the pre-restore step on a fresh cluster (docs/RUNBOOK.md
// §5): there is no schema yet, so there is nothing to seed into.
if (!rolesOnly) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
  await seedTestUser({ adminUrl });
}
