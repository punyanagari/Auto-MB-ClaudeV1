import type { Sql } from '@auto-mb/db';
import type { AppInstance } from '../../app-instance.js';
import type { Auth } from '../../auth.js';
import type { StatutoryProvider } from '../../gsp/statutory-provider.js';
import type { ObjectStorage } from '@auto-mb/documents';
import { registerTaxInvoiceCancelRoute } from './cancel.js';
import { registerTaxInvoiceDraftingRoutes } from './drafting.js';
import { registerTaxInvoiceProviderRoutes } from './provider.js';
import { registerTaxInvoiceRenderRoutes } from './render.js';
import { registerTaxInvoiceSubmitRoute } from './submit.js';

export { financialYearLabel, requireEinvoiceDeclared } from './internal.js';

/**
 * The GST tax invoice (migration 0035), assembled from its per-concern
 * modules. The module documentation, row shapes and shared guards live
 * in ./internal.ts; the lifecycle is drafting -> submit -> (render,
 * IRP transport) -> cancel, and each of those is its own file.
 *
 * One register function, as before: app.ts calls this and gets every
 * tax-invoice route.
 */
export function registerTaxInvoiceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  provider?: StatutoryProvider,
): void {
  registerTaxInvoiceDraftingRoutes(app, auth, database);
  registerTaxInvoiceSubmitRoute(app, auth, database);
  registerTaxInvoiceRenderRoutes(app, auth, database, storage, gotenbergUrl);
  registerTaxInvoiceProviderRoutes(app, auth, database, provider);
  registerTaxInvoiceCancelRoute(app, auth, database);
}
