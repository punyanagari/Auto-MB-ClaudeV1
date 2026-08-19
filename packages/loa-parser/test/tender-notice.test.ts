import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reviewTenderNotice } from '../src/tender-notice.js';

/** A notice in the shape Poppler's `-layout` view produces: labelled
 * lines, the name of work wrapped across two, Indian rupee grouping. */
const NOTICE = [
  'WESTERN RAILWAY',
  'NOTICE INVITING E-TENDER',
  '',
  'Tender No.: WR-MMCT-S&T-34/2026',
  'Inviting Authority: Western Railway, Mumbai Central Division',
  'Name of Work: Supply and commissioning of IP passenger information',
  'systems at twelve stations.',
  'Closing Date & Time: 18-09-2026 15:00 hrs',
  'Estimated Cost: Rs. 8,40,00,000/-',
  'EMD: Rs 16.80 Lakh',
  'Eligibility Criteria: Similar railway S&T works of 35% value in the last',
  'three financial years.',
  '',
  'Payment terms: as per the tender document.',
].join('\n');

describe('reviewTenderNotice', () => {
  it('reads the six first-page fields off a notice', () => {
    const review = reviewTenderNotice(NOTICE);

    expect(review.tenderNumber.value).toBe('WR-MMCT-S&T-34/2026');
    expect(review.authority.value).toBe('Western Railway, Mumbai Central Division');
    expect(review.title.value).toBe(
      'Supply and commissioning of IP passenger information systems at twelve stations.',
    );
    expect(review.bidClosesAtLocal.value).toBe('2026-09-18T15:00');
    expect(review.estimatedValue.value).toBe('84000000.00');
    expect(review.emdAmount.value).toBe('1680000.00');
    expect(review.eligibility.value).toBe(
      'Similar railway S&T works of 35% value in the last three financial years.',
    );

    expect(review.needsReview.total).toBe(0);
    expect(review.needsReview.identityUnresolved).toBe(false);
  });

  it('keeps every field independent and flags the ones it cannot find', () => {
    const review = reviewTenderNotice(
      ['Tender No: RDSO/2026/EL/041', 'EMD: ₹ 9.60 Lakh'].join('\n'),
    );

    expect(review.tenderNumber.value).toBe('RDSO/2026/EL/041');
    expect(review.emdAmount.value).toBe('960000.00');
    expect(review.authority).toEqual({ value: null, raw: null, needsReview: true });
    expect(review.estimatedValue.value).toBeNull();
    expect(review.needsReview.identityUnresolved).toBe(true);
  });

  it('flags a closing date that states no time rather than inventing midnight', () => {
    const review = reviewTenderNotice('Last date for submission: 02/03/2027');
    expect(review.bidClosesAtLocal.value).toBe('2027-03-02T00:00');
    expect(review.bidClosesAtLocal.needsReview).toBe(true);
  });

  it('refuses a closing date the calendar does not have', () => {
    const review = reviewTenderNotice('Due date: 31-02-2027 15:00');
    expect(review.bidClosesAtLocal.value).toBeNull();
    expect(review.bidClosesAtLocal.needsReview).toBe(true);
  });

  it('reads a 12-hour closing time', () => {
    const review = reviewTenderNotice('Bid submission end date: 18-09-2026 3:00 PM');
    expect(review.bidClosesAtLocal.value).toBe('2026-09-18T15:00');
    expect(review.bidClosesAtLocal.needsReview).toBe(false);
  });

  it('scales crore and lakh exactly, without a binary float', () => {
    const review = reviewTenderNotice(
      ['Estimated cost: ₹ 8.47 Cr', 'Earnest Money Deposit: INR 16.94 Lakh'].join('\n'),
    );
    expect(review.estimatedValue.value).toBe('84700000.00');
    expect(review.emdAmount.value).toBe('1694000.00');
  });

  it('never lets the amount-in-words parenthetical multiply the figure', () => {
    // The corpus shape. Reading "Crore" out of the words and applying it
    // to a figure that already carries it turns eight crore into eight
    // lakh crore, silently, on the number an agency deposits.
    const review = reviewTenderNotice(
      [
        'Estimated Cost: Rs. 8,40,00,000/- (Rupees Eight Crore Forty Lakh only)',
        'EMD: Rs. 2,00,000/- (Rupees Two Lakh only)',
      ].join('\n'),
    );

    expect(review.estimatedValue.value).toBe('84000000.00');
    expect(review.emdAmount.value).toBe('200000.00');
    // Both are flagged: the notice states the amount twice and this
    // reader only reads one of the two statements.
    expect(review.estimatedValue.needsReview).toBe(true);
    expect(review.emdAmount.needsReview).toBe(true);
  });

  it('applies a scale word that really does qualify the figure', () => {
    const review = reviewTenderNotice('Estimated cost: Rs 8.40 Cr');
    expect(review.estimatedValue.value).toBe('84000000.00');
    expect(review.estimatedValue.needsReview).toBe(false);
  });

  it('refuses a figure too wide for the money column instead of storing a misread', () => {
    const review = reviewTenderNotice('Tender value: Rs 9,99,99,99,99,99,99,999 Cr');
    expect(review.estimatedValue.value).toBeNull();
    expect(review.estimatedValue.needsReview).toBe(true);
  });

  it('proposes and never commits — the module exports no writer', async () => {
    const module: Record<string, unknown> = await import('../src/tender-notice.js');
    expect(Object.keys(module)).toEqual(['reviewTenderNotice']);
  });
});

/**
 * The IREPS "TENDER DOCUMENT" shape, against the real notice the owner's
 * intake failed on (IREPS tender 5390021, Bhopal division S&T, published
 * 22/05/2026).
 *
 * ## Why the fixture is committed, and committed as text
 *
 * The corpus discipline this package has held since DC-22: the evidence
 * is the `pdftotext -layout` EXTRACTION, never the PDF. A binary in the
 * tree is unreviewable in a diff, unsearchable, and carries whatever the
 * publisher embedded in it; the text is the input the parser actually
 * receives, and `test/corpus-manifest.test.ts` already refuses anything
 * in `fixtures/` that is not a `.txt`.
 *
 * The digest below is the same guard `corpus.json`'s `sha256` field is
 * for, applied to a notice rather than to a letter. An edited figure or a
 * silently reflowed line changes every byte of the digest, so the
 * expectations underneath are pinned to a text nobody has quietly
 * corrected into passing. It is asserted HERE rather than added to
 * `corpus.json`, because that manifest is the six-LOA regression corpus —
 * its own test asserts exactly six letters and demands an item count, a
 * pricing shape and a net bid value of every entry, none of which a
 * notice inviting tender has.
 *
 * The one alteration made to the extraction: CRLF line endings were
 * normalised to LF, which is what every other fixture in the directory
 * carries. Line endings are not evidence, and a fixture whose digest
 * depended on the checkout platform would be a pin that pins nothing.
 */
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'NIT-BPL-5390021.txt',
);
const FIXTURE_SHA256 =
  '4a953f052dff87818e46c9a1aff3680aa49d94de22cdbfcf1fcea40ed2e81c9c';

describe('reviewTenderNotice — the IREPS tender document layout', () => {
  const raw = readFileSync(FIXTURE_PATH);
  const text = raw.toString('utf8');

  it('reads the pinned corpus fixture, byte for byte', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FIXTURE_SHA256);
  });

  it('reads all six identity fields off the notice, confidently', () => {
    const review = reviewTenderNotice(text);

    // (a) The columnar header line. The capture stops at the column gap,
    // so the closing-date column that sits to its right is not part of
    // the number — which is the defect the owner's intake hit.
    expect(review.tenderNumber.value).toBe('BPLNWKS2026-27TELEAMC02');
    expect(review.tenderNumber.needsReview).toBe(false);

    // (a) again: the same line's second column, read as a closing moment.
    expect(review.bidClosesAtLocal.value).toBe('2026-06-15T15:00');
    expect(review.bidClosesAtLocal.needsReview).toBe(false);

    // (b) The four-column NIT HEADER table, first value column only.
    expect(review.estimatedValue.value).toBe('11503728.60');
    expect(review.estimatedValue.needsReview).toBe(false);
    expect(review.emdAmount.value).toBe('230100.00');
    expect(review.emdAmount.needsReview).toBe(false);

    // (c) The Name of Work cell, wrapped over four printed lines that run
    // both above and below the label's own line.
    expect(review.title.value).toBe(
      'Comprehensive Annual Maintenance Contract of Partronics make Central Data ' +
        'Controller unit, Coach Guidance System, Platform Data Communication Hub, ' +
        'At a Glace Display Board, Single Line Display Board, and GPS based Clock ' +
        'installed at MABA, ASKN, RTA and SHRN for a period of 5 years.',
    );
    expect(review.title.needsReview).toBe(false);

    // (d) The masthead above the banner, which is the only place an IREPS
    // page names the inviting division and zone.
    expect(review.authority.value).toBe('BHOPAL DIVISION-S AND T/WEST CENTRAL RLY');
    expect(review.authority.needsReview).toBe(false);

    expect(review.needsReview.identityUnresolved).toBe(false);
  });

  it('never reads the paired second column of a NIT HEADER row as the value', () => {
    // Both rows print a SECOND label and value to the right — "Tendering
    // Section  SNT TELE" beside the advertised value, "Validity of Offer
    // ( Days)  60" beside the earnest money. Reading either would put a
    // bid validity of 60 into the deposit an agency has to lodge.
    const review = reviewTenderNotice(text);
    expect(review.estimatedValue.value).not.toBe('60.00');
    expect(review.emdAmount.value).not.toBe('60.00');
    expect(review.estimatedValue.raw).toContain('Tendering Section');
    expect(review.emdAmount.raw).toContain('Validity of Offer');
  });

  it('leaves eligibility unread on this shape rather than guessing at it', () => {
    // The page states its eligibility as section 4, a table of numbered
    // financial criteria running to a dozen printed lines — not a
    // labelled field. Nothing here invents one: the field stays null and
    // flagged, and the reviewer supplies it. That is the whole of this
    // notice's review load, which is what the count asserts.
    const review = reviewTenderNotice(text);
    expect(review.eligibility.value).toBeNull();
    expect(review.eligibility.needsReview).toBe(true);
    expect(review.needsReview.total).toBe(1);
  });

  it('reads the header line off the first page, not a later page repeat', () => {
    // The masthead, the banner and the header line are reprinted on all
    // five pages. First match wins, and every repeat states the same
    // facts, so a truncated extraction that lost page 1 would still be
    // read rather than half-read.
    const fromPageTwo = text.slice(text.indexOf('Page 1 of 5'));
    const review = reviewTenderNotice(fromPageTwo);
    expect(review.tenderNumber.value).toBe('BPLNWKS2026-27TELEAMC02');
    expect(review.bidClosesAtLocal.value).toBe('2026-06-15T15:00');
    expect(review.authority.value).toBe('BHOPAL DIVISION-S AND T/WEST CENTRAL RLY');
  });

  it('stays out of the way of a notice that is not an IREPS page', () => {
    // The columnar reader is gated on the banner line, so the labelled
    // shape above reads exactly as it did. Asserted here as well as in
    // the first suite because "no regression on the other shapes" is the
    // property, not an implementation detail of the gate.
    const review = reviewTenderNotice(NOTICE);
    expect(review.tenderNumber.value).toBe('WR-MMCT-S&T-34/2026');
    expect(review.authority.value).toBe('Western Railway, Mumbai Central Division');
    expect(review.needsReview.total).toBe(0);
  });
});
