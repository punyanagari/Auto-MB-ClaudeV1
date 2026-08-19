import { randomBytes } from 'node:crypto';
import type { Sql } from '@auto-mb/db';

/**
 * The railway measurement a seeded On-Account Bill needs to exist
 * (migration 0111).
 *
 * Since 0111 a received railway bill records against a Measurement Book
 * only when that book's railway measurement is on file and either matched
 * by the reading or confirmed line by line. Five suites seed a bill
 * straight into the table — because their subject is what happens AFTER a
 * bill exists, not how one comes to be recorded — and each of them needs
 * the precondition in place first.
 *
 * ## Why `unreadable` plus confirmations, and not `matched`
 *
 * A `matched` row would be a fixture asserting a comparison that never
 * happened: these books are inserted directly, most of them carry no
 * `measurement_book_lines` at all, and there is no railway document
 * anywhere near them. `unreadable` is the honest row — nobody read
 * anything — and the confirmations below are the honest way past the
 * gate, one per line the book actually has, which is exactly what an
 * operator would have had to do.
 *
 * The confirmation insert is a `select` over the book's own lines, so a
 * book with none needs none and a book with twelve gets twelve, without
 * any caller having to know which it is.
 *
 * The gate itself is proved in `railway-measurements.integration.test.ts`
 * — including that a half-confirmed measurement is still refused. This
 * helper exists so the OTHER suites keep testing their own subjects.
 */
export async function seedConfirmedRailwayMeasurement(
  admin: Sql,
  options: {
    readonly organisationId: string;
    readonly workId: string;
    readonly measurementBookId: string;
    readonly userId: string;
  },
): Promise<string> {
  const [measurement] = await admin<{ id: string }[]>`
    insert into railway_measurements (
      organisation_id, work_id, measurement_book_id, object_key,
      original_filename, sha256, media_type, size_bytes, match_status,
      line_verdicts, uploaded_by_user_id
    )
    values (
      ${options.organisationId}, ${options.workId}, ${options.measurementBookId},
      ${`${options.organisationId}/railwaymeasurement/${options.measurementBookId}.pdf`},
      'measurement.pdf', ${randomBytes(32).toString('hex')}, 'application/pdf',
      1024, 'unreadable', '[]'::jsonb, ${options.userId}
    )
    returning id
  `;
  if (measurement === undefined) {
    throw new Error('seed railway measurement insert returned no row');
  }
  await admin`
    insert into railway_measurement_confirmations (
      organisation_id, railway_measurement_id, item_number, confirmed_by_user_id
    )
    select ${options.organisationId}, ${measurement.id}, l.item_number,
           ${options.userId}
    from measurement_book_lines l
    where l.organisation_id = ${options.organisationId}
      and l.measurement_book_id = ${options.measurementBookId}
  `;
  return measurement.id;
}
