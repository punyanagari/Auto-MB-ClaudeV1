import {
  MeasurementBookDetailResponseSchema,
  type MeasurementBookClosureRefusalDetails,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { assertWorkAccess } from '../../authz.js';
import { httpError } from '../../http.js';
import { liveRailwayBillForBook } from '../received-railway-bills.js';
import { audit, errorResponses, IdParamsSchema } from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import { readDetail } from './internal.js';

/**
 * Closing a measurement against the railway.
 *
 * A finalized Measurement Book is this agency's statement of what it
 * measured. Closure is the railway AGREEING: the On-Account Bill comes
 * back from IWRCMS with three signatures on it, and until that happens
 * the measurement is outstanding however complete our own paperwork
 * looks. That is the fact this route records, and the fact the payment
 * gate in `retention.ts` rests on.
 *
 * It is deliberately an explicit act rather than something that happens
 * on upload. Recording the bill is bookkeeping and always succeeds — a
 * badly signed bill is still evidence, and refusing to file a document
 * because its verdict is inconvenient would lose the very record that
 * proves it. Closing is the judgement, and a judgement gets its own
 * button and its own refusal.
 */
export function registerMeasurementBookCloseRoute(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/close',
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [book] = await tx<
          { work_id: string; status: string; closed_at: Date | null }[]
        >`
          select work_id, status, closed_at from measurement_books
          where id = ${id} for update
        `;
        if (book === undefined) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.closed_at !== null) {
          throw httpError(
            409,
            'MB_ALREADY_CLOSED',
            'This measurement is already closed by a railway bill.',
          );
        }
        if (book.status !== 'finalized') {
          throw httpError(
            409,
            'MB_NOT_FINALIZED',
            `Only a finalized Measurement Book is closed; this one is ${book.status}.`,
          );
        }

        const bill = await liveRailwayBillForBook(tx, id);
        if (bill === null) {
          const details: MeasurementBookClosureRefusalDetails = {
            measurementBookId: id,
            receivedRailwayBillId: null,
            refusal: null,
            detail: null,
          };
          throw httpError(
            409,
            'MB_RAILWAY_BILL_MISSING',
            'No railway bill is recorded against this measurement, so there is nothing ' +
              'saying the railway accepted it.',
            details,
          );
        }
        // The gate, in one place: the same assessment the list shape
        // reports as `settleable`, so a screen that shows a bill as
        // acceptable can never meet a route that disagrees.
        if (!bill.settleable) {
          const details: MeasurementBookClosureRefusalDetails = {
            measurementBookId: id,
            receivedRailwayBillId: bill.id,
            refusal: bill.settlementRefusal,
            detail: bill.settlementRefusalDetail,
          };
          throw httpError(
            409,
            'MB_RAILWAY_BILL_UNVERIFIED',
            `Bill ${bill.billNumber} cannot close this measurement. ` +
              (bill.settlementRefusalDetail ?? 'Its signatures were not accepted.'),
            details,
          );
        }

        await tx`
          update measurement_books
          set closed_at = now(), closed_by_user_id = ${user.id},
              closed_by_received_bill_id = ${bill.id}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.closed',
          'measurement_books',
          id,
          {
            receivedRailwayBillId: bill.id,
            billNumber: bill.billNumber,
            billDate: bill.billDate,
            billAmount: bill.billAmount,
            signatureStatus: bill.signatureStatus,
          },
        );
        return readDetail(tx, id);
      });
    },
  );
}
