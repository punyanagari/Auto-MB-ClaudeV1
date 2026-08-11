/**
 * Exact item-description recovery from Poppler's `pdftotext -raw` view.
 *
 * The existing `-layout` view remains authoritative for schedules and every
 * numeric column. Its physical lines cannot, however, prove which neighbour
 * owns prose printed between two item anchors. Poppler's raw reading order
 * emits the item-serial cell, then that row's description cell, then its
 * numeric tail. This module uses the already-validated layout rows as a
 * strict oracle for that order and returns descriptions only when the whole
 * letter passes an all-or-nothing quality gate.
 */
import { isPrintFurnitureLine } from './furniture.js';

const ITEM_TABLE_MARKER = 'Awarded Quantities And Rates';
const SCHEDULE_HEADER_RE = /^Schedule\s+([A-Z][A-Za-z0-9]*)-/;
const SCHEDULE_TOTALS_RE = /^Schedule Totals\b/;
const ROW_START_RE = /^(\d+)(?:\s+(.*))?$/;
const PAR_TOKEN_RE = /\b(?:At Par|Below Par|Above Par)\b/;
const TAIL_RE =
  /^(\S+)\s+([\d,]+(?:\.\d+)?)\s+(?:(.*?)\s+)?([\d,]+\.\d{2})\s+(At Par|Below Par|Above Par)\s+([\d,]+\.\d{2})$/;

export interface RawItemExpectation {
  readonly scheduleId: string | null;
  readonly itemSno: string;
  readonly itemCode: string;
  readonly qty: string;
  readonly qtyUnit: string | null;
  readonly qtyUnitWrapped: boolean;
  readonly unitRate: string;
  readonly parToken: 'At Par' | 'Below Par' | 'Above Par';
  readonly bidAmount: string;
}

export interface ExactRawDescription {
  readonly description: string;
  readonly sourceLines: readonly string[];
}

export type RawDescriptionRecovery =
  | {
      readonly ok: true;
      readonly descriptions: readonly ExactRawDescription[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface RawTail {
  readonly itemCode: string;
  readonly qty: string;
  readonly qtyUnit: string | null;
  readonly unitRate: string;
  readonly parToken: 'At Par' | 'Below Par' | 'Above Par';
  readonly bidAmount: string;
}

interface ExpectedSchedule {
  readonly id: string;
  readonly items: readonly RawItemExpectation[];
}

interface CurrentRow {
  readonly expected: RawItemExpectation;
  readonly descriptionLines: string[];
  tail: RawTail | null;
}

function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeNumber(value: string): string {
  return value.replaceAll(',', '');
}

/**
 * A form feed can share a physical output line with both the preceding page
 * footer and the next page's first description fragment. Split it before
 * furniture removal so the footer is dropped while the continuation is
 * retained (`... 3/7\fthrough HDPE...` is a real observed case).
 */
function normalizedRawLines(rawText: string): readonly string[] {
  return rawText
    .replace(/\r\n?/g, '\n')
    .replaceAll('\f', '\n')
    .split('\n')
    .filter((line) => !isPrintFurnitureLine(line))
    .map(normalizeSpace)
    .filter((line) => line.length > 0);
}

function parseTail(line: string): RawTail | null {
  const match = TAIL_RE.exec(line);
  if (match === null) return null;
  const parToken = match[5];
  if (parToken !== 'At Par' && parToken !== 'Below Par' && parToken !== 'Above Par') {
    return null;
  }
  const unit = normalizeSpace(match[3] ?? '');
  return {
    itemCode: match[1] ?? '',
    qty: match[2] ?? '',
    qtyUnit: unit.length === 0 ? null : unit,
    unitRate: match[4] ?? '',
    parToken,
    bidAmount: match[6] ?? '',
  };
}

function tailMatchesExpected(tail: RawTail, expected: RawItemExpectation): boolean {
  const expectedUnit =
    expected.qtyUnit === null ? null : normalizeSpace(expected.qtyUnit);
  const unitMatches =
    tail.qtyUnit === expectedUnit ||
    (expected.qtyUnitWrapped && tail.qtyUnit === null && expectedUnit !== null);
  return (
    tail.itemCode === expected.itemCode &&
    normalizeNumber(tail.qty) === normalizeNumber(expected.qty) &&
    unitMatches &&
    normalizeNumber(tail.unitRate) === normalizeNumber(expected.unitRate) &&
    tail.parToken === expected.parToken &&
    normalizeNumber(tail.bidAmount) === normalizeNumber(expected.bidAmount)
  );
}

function groupExpectedSchedules(
  expectations: readonly RawItemExpectation[],
): readonly ExpectedSchedule[] | null {
  const schedules: { id: string; items: RawItemExpectation[] }[] = [];
  const seen = new Set<string>();
  for (const item of expectations) {
    if (item.scheduleId === null) return null;
    const previous = schedules.at(-1);
    if (previous?.id === item.scheduleId) {
      previous.items.push(item);
      continue;
    }
    if (seen.has(item.scheduleId)) return null;
    seen.add(item.scheduleId);
    schedules.push({ id: item.scheduleId, items: [item] });
  }
  return schedules;
}

/**
 * Recovers descriptions in positional layout-row order. Any ambiguity,
 * missing tail, tuple mismatch, empty description, unexpected schedule, or
 * row-count difference rejects the entire recovery. Callers must retain the
 * conservative layout descriptions and raise review on `ok: false`.
 */
export function recoverRawItemDescriptions(
  rawText: string,
  expectations: readonly RawItemExpectation[],
): RawDescriptionRecovery {
  if (expectations.length === 0) {
    return { ok: true, descriptions: [] };
  }

  const schedules = groupExpectedSchedules(expectations);
  if (schedules === null) {
    return { ok: false, reason: 'layout rows are not bound to unique schedules' };
  }

  const allLines = normalizedRawLines(rawText);
  const markerIndex = allLines.findIndex((line) => line === ITEM_TABLE_MARKER);
  if (markerIndex === -1) {
    return { ok: false, reason: 'raw item-table marker not found' };
  }
  const lines = allLines.slice(markerIndex + 1);

  const recovered: ExactRawDescription[] = [];
  let nextScheduleIndex = 0;
  let activeSchedule: ExpectedSchedule | null = null;
  let nextItemIndex = 0;
  let current: CurrentRow | null = null;
  let failure: string | null = null;

  const fail = (reason: string): false => {
    failure ??= reason;
    return false;
  };

  const finishCurrent = (): boolean => {
    if (current === null) return true;
    if (current.tail === null) {
      return fail(
        `raw numeric tail missing for ${current.expected.scheduleId ?? 'UNBOUND'}#${current.expected.itemSno}`,
      );
    }
    if (current.descriptionLines.length === 0) {
      return fail(
        `raw description empty for ${current.expected.scheduleId ?? 'UNBOUND'}#${current.expected.itemSno}`,
      );
    }
    recovered.push({
      description: current.descriptionLines.join(' '),
      sourceLines: [...current.descriptionLines],
    });
    current = null;
    return true;
  };

  const finishSchedule = (): boolean => {
    if (activeSchedule === null) return true;
    if (!finishCurrent()) return false;
    if (nextItemIndex !== activeSchedule.items.length) {
      return fail(
        `raw schedule ${activeSchedule.id} has ${String(nextItemIndex)} of ${String(activeSchedule.items.length)} expected rows`,
      );
    }
    activeSchedule = null;
    nextItemIndex = 0;
    return true;
  };

  for (const line of lines) {
    if (failure !== null) break;

    const scheduleMatch = SCHEDULE_HEADER_RE.exec(line);
    if (scheduleMatch !== null) {
      if (!finishSchedule()) break;
      const expectedSchedule = schedules[nextScheduleIndex];
      const printedId = scheduleMatch[1] ?? '';
      if (expectedSchedule === undefined || expectedSchedule.id !== printedId) {
        fail(`unexpected raw schedule ${printedId}`);
        break;
      }
      activeSchedule = expectedSchedule;
      nextScheduleIndex += 1;
      continue;
    }

    if (SCHEDULE_TOTALS_RE.test(line)) {
      if (!finishSchedule()) break;
      continue;
    }

    if (activeSchedule === null) continue;

    const tail = parseTail(line);
    if (tail !== null) {
      if (current === null) {
        fail(`raw numeric tail appears before a row in schedule ${activeSchedule.id}`);
        break;
      }
      if (current.tail !== null) {
        fail(
          `duplicate raw numeric tail for ${activeSchedule.id}#${current.expected.itemSno}`,
        );
        break;
      }
      if (!tailMatchesExpected(tail, current.expected)) {
        fail(
          `raw/layout tuple mismatch for ${activeSchedule.id}#${current.expected.itemSno}`,
        );
        break;
      }
      current.tail = tail;
      continue;
    }
    if (PAR_TOKEN_RE.test(line)) {
      fail(`unparsed raw numeric tail in schedule ${activeSchedule.id}`);
      break;
    }

    const rowStart = ROW_START_RE.exec(line);
    const nextExpected = activeSchedule.items[nextItemIndex];
    const canStart = current === null || current.tail !== null;
    if (
      rowStart !== null &&
      nextExpected !== undefined &&
      canStart &&
      (rowStart[1] ?? '') === nextExpected.itemSno
    ) {
      if (!finishCurrent()) break;
      const firstDescriptionLine = normalizeSpace(rowStart[2] ?? '');
      current = {
        expected: nextExpected,
        descriptionLines:
          firstDescriptionLine.length === 0 ? [] : [firstDescriptionLine],
        tail: null,
      };
      nextItemIndex += 1;
      continue;
    }

    // Digit-leading prose is common (`4 of tender document.`, `10 sq. mm`).
    // Before the current row's numeric tail it cannot be the next serial
    // cell, so it remains description text.
    if (current !== null) current.descriptionLines.push(line);
  }

  if (failure === null) finishSchedule();
  if (failure !== null) return { ok: false, reason: failure };
  if (nextScheduleIndex !== schedules.length) {
    return { ok: false, reason: 'raw extraction is missing one or more schedules' };
  }
  if (recovered.length !== expectations.length) {
    return {
      ok: false,
      reason: `raw extraction recovered ${String(recovered.length)} of ${String(expectations.length)} rows`,
    };
  }
  return { ok: true, descriptions: recovered };
}
