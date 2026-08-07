/**
 * @auto-mb/loa-parser — the split letter-number rejoin (DC-23; legacy ticket DC-23;
 * docs/reference/loa-parser-contract.md §3 "Letter-number wrap trap").
 *
 * The letter number is interrupted mid-word by the interleaved `Dated:`
 * line:
 *
 *     Letter No: JHANSI DIVISION-S AND T / JHS-N-
 *                                              Dated: 09/02/2026
 *     W-71-25 / 00341490150678
 *
 * A naive line-wise regex captures only the first line's fragment
 * ("JHANSI DIVISION-S AND T / JHS-N-") and silently drops the rest. This
 * module reads the three physical lines explicitly — the `Letter No:` line,
 * the interleaved `Dated:` line (whose value becomes `letterDate`, per the
 * ticket), and the continuation line — and rejoins the letter-number
 * fragments with the same hyphen-aware join every wrap-broken field in this
 * corpus uses (text.ts's `hyphenJoin`).
 */
import { parseDdMmYyyy } from './dates.js';
import { found, notFound, preview, type FieldResult } from './field.js';
import { hyphenJoin } from './text.js';

const LETTER_NO_RE = /Letter No\s*:/;
const DATED_RE = /Dated\s*:/;

export interface LetterNumberAndDate {
  readonly letterNumber: FieldResult<string>;
  readonly letterDate: FieldResult<string>;
}

/**
 * Reads the next `count` non-blank lines starting at `fromIndex` (exclusive)
 * — tolerant of any accidental blank lines between the `Letter No:` line and
 * its continuation, though none are present in the corpus as printed.
 */
function nextNonBlankLines(
  lines: readonly string[],
  fromIndex: number,
  count: number,
): string[] {
  const collected: string[] = [];
  for (let i = fromIndex; i < lines.length && collected.length < count; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length > 0) {
      collected.push(line);
    }
  }
  return collected;
}

/**
 * Extracts the letter number and letter date from the furniture-stripped
 * header text. Operates on physical lines (not flattened prose) because the
 * rejoin depends on exactly which two lines interleave.
 */
export function extractLetterNumberAndDate(headerText: string): LetterNumberAndDate {
  const lines = headerText.split('\n');
  const letterNoIdx = lines.findIndex((l) => LETTER_NO_RE.test(l));

  if (letterNoIdx === -1) {
    const raw = preview(headerText, 400);
    return { letterNumber: notFound(raw), letterDate: notFound(raw) };
  }

  const letterNoLine = lines[letterNoIdx] ?? '';
  const leftFragment = letterNoLine.replace(/^.*?Letter No\s*:\s*/, '').trim();

  const [datedLine, continuationLine] = nextNonBlankLines(lines, letterNoIdx + 1, 2);

  if (datedLine === undefined || !DATED_RE.test(datedLine)) {
    const raw = preview(lines.slice(letterNoIdx, letterNoIdx + 4).join('\n'));
    return { letterNumber: notFound(raw), letterDate: notFound(raw) };
  }

  const dateRaw = datedLine.replace(/^.*?Dated\s*:\s*/, '').trim();
  const letterDateIso = parseDdMmYyyy(dateRaw);
  const letterDate: FieldResult<string> =
    letterDateIso === null ? notFound(dateRaw) : found(letterDateIso, datedLine);

  if (continuationLine === undefined) {
    const raw = preview([letterNoLine, datedLine].join('\n'));
    return { letterNumber: notFound(raw), letterDate };
  }

  const letterNumberValue = hyphenJoin([leftFragment, continuationLine]);
  const rawBlock = [letterNoLine, datedLine, continuationLine].join('\n');

  return {
    letterNumber: found(letterNumberValue, rawBlock),
    letterDate,
  };
}
