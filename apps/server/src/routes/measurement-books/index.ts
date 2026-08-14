import type { Sql } from '@auto-mb/db';
import type { AppInstance } from '../../app-instance.js';
import type { Auth } from '../../auth.js';
import type { ObjectStorage } from '@auto-mb/documents';
import { registerMeasurementBookCloseRoute } from './close.js';
import { registerMeasurementBookDraftingRoutes } from './drafting.js';
import { registerMeasurementBookFinalizeRoutes } from './finalize.js';
import { registerMeasurementBookMergeRoutes } from './merge.js';
import { registerMeasurementBookRenderRoutes } from './render.js';
import { registerMeasurementBookSourceRoutes } from './sources.js';

export { assertSourceNotBilled } from './internal.js';

/**
 * The stage-wise Measurement Book (Milestone 8), assembled from its
 * per-concern modules. The module documentation, row shapes, live-state
 * computation and source-claim helpers live in ./internal.ts; the
 * lifecycle is drafting (and merge) -> sources -> finalize -> render,
 * with closure against the railway's own bill after that (0066),
 * and each of those is its own file.
 *
 * One register function, as before: app.ts calls this and gets every
 * Measurement Book route.
 */
export function registerMeasurementBookRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
): void {
  registerMeasurementBookDraftingRoutes(app, auth, database);
  registerMeasurementBookMergeRoutes(app, auth, database);
  registerMeasurementBookSourceRoutes(app, auth, database);
  registerMeasurementBookFinalizeRoutes(app, auth, database);
  registerMeasurementBookCloseRoute(app, auth, database);
  registerMeasurementBookRenderRoutes(app, auth, database, storage, gotenbergUrl);
}
