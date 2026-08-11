import { describe, expect, it, vi } from 'vitest';
import {
  extractHeader,
  flatten,
  isPrintFurnitureLine,
  loadCorpus,
  loadLetter,
  parseDdMmYyyy,
  stripPrintFurniture,
  indianWordsToNumber,
  parseRupeesWords,
  type LoaHeader,
} from '../src/index.js';

const ALL_LETTER_IDS = [
  'PL273-JHS',
  'PL280-ADI',
  'PL275-BKN',
  'PL276-GTL',
  'PL270-CRB',
  'PL281-BB',
] as const;

// CORPUS COUNT CORRECTION (dispatch note): the corpus is SIX letters, not
// five — loadCorpus() is the source of truth (DC-22;
// docs/reference/loa-parser-contract.md §0). Every criterion below runs over
// all six, including PL281-BB, the only %Above letter.
it('sanity: the corpus is six letters', () => {
  expect(loadCorpus().length).toBe(6);
  expect(
    loadCorpus()
      .map((l) => l.manifest.id)
      .sort(),
  ).toEqual([...ALL_LETTER_IDS].sort());
});

// ---------------------------------------------------------------------------
// Criterion: print-furniture stripping runs before any structural parsing
// ---------------------------------------------------------------------------

describe('print-furniture stripping', () => {
  it('normalises Windows CRLF before stripping or structural parsing', () => {
    const lf = loadLetter('PL281-BB').text;
    const crlf = lf.replace(/\n/g, '\r\n');

    expect(stripPrintFurniture(crlf)).toBe(stripPrintFurniture(lf));
    expect(extractHeader(crlf)).toEqual(extractHeader(lf));
  });

  it('recognises both observed furniture forms on all six fixtures', () => {
    for (const id of ALL_LETTER_IDS) {
      const { text } = loadLetter(id);
      const furnitureLines = text.split('\n').filter((l) => isPrintFurnitureLine(l));
      expect(furnitureLines.length, `${id}: expected furniture lines`).toBeGreaterThan(
        0,
      );
      // Every fixture repeats the header/footer once per printed page — both
      // forms must be present given the corpus is a multi-page print.
      const headerForm = furnitureLines.some(
        (l) => /ireps\.gov\.in\/epsn\/w\s?orks/.test(l) && !l.startsWith('https'),
      );
      const footerForm = furnitureLines.some((l) => l.trim().startsWith('https://'));
      expect(headerForm, `${id}: page-header furniture form present`).toBe(true);
      expect(footerForm, `${id}: page-footer furniture form present`).toBe(true);
    }
  });

  // DC-23 review round 1 [B1, BLOCKER]: the previous version of this test
  // filtered BOTH the "remaining furniture" set AND the "expected surviving
  // lines" set through the same isPrintFurnitureLine predicate under test —
  // circular, so it could never catch a class of furniture line the
  // predicate itself failed to recognise. It missed exactly that: page-2+
  // print headers carry a leading FORM-FEED byte (`\f`), not plain
  // space/tab indentation (`\f2/9/26, 1:47 PM  ireps.gov.in/...`, e.g.
  // PL273-JHS.txt lines 66/124/184), and the old `^[ \t]*` leading class did
  // not include `\f`. Measured: 42 of 96 furniture lines corpus-wide
  // survived stripping (PL273 3/8, PL280 4/10, PL275 5/12, PL276 8/18, PL270
  // 16/34, PL281 6/14), 1-2 inside the header region on every one of the six
  // fixtures. These replacement assertions are DIRECT: they scan the
  // stripped OUTPUT text itself for the literal leaked substrings, using no
  // predicate from the module under test.
  it('stripPrintFurniture leaves no "ireps.gov.in" substring and no page-header date/time pattern anywhere in the output, on all six fixtures', () => {
    const printHeaderDateTimeRe =
      /\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*(AM|PM)/;
    for (const id of ALL_LETTER_IDS) {
      const { text } = loadLetter(id);
      const stripped = stripPrintFurniture(text);
      expect(stripped, `${id}: leaked "ireps.gov.in"`).not.toContain('ireps.gov.in');
      expect(stripped, `${id}: leaked "https://"`).not.toContain('https://');
      expect(
        printHeaderDateTimeRe.test(stripped),
        `${id}: leaked a page-header date/time pattern`,
      ).toBe(false);
    }
  });

  it('removes an exact, independently-known furniture-line count per fixture, and preserves every other line in order', () => {
    // Independently computed (NOT via isPrintFurnitureLine) from a loose
    // byte-pattern scan of the raw fixtures, cross-checked against the
    // reviewer's measurement: 8 + 10 + 12 + 18 + 34 + 14 = 96 total furniture
    // lines corpus-wide.
    const expectedFurnitureLineCount: Record<string, number> = {
      'PL273-JHS': 8,
      'PL280-ADI': 10,
      'PL275-BKN': 12,
      'PL276-GTL': 18,
      'PL270-CRB': 34,
      'PL281-BB': 14,
    };
    const looseFurnitureRe =
      /ireps\.gov\.in\/epsn\/w\s?orks|https:\/\/w\s?w\s?w\s?\.ireps/;
    for (const id of ALL_LETTER_IDS) {
      const { text } = loadLetter(id);
      const originalLines = text.split('\n');
      const stripped = stripPrintFurniture(text);
      const strippedLines = stripped.split('\n');

      const looseFurnitureLines = originalLines.filter((l) => looseFurnitureRe.test(l));
      expect(looseFurnitureLines.length, `${id}: known furniture-line count`).toBe(
        expectedFurnitureLineCount[id],
      );

      const expectedRemaining = originalLines.filter((l) => !looseFurnitureRe.test(l));
      expect(
        strippedLines,
        `${id}: preserves every non-furniture line, in order`,
      ).toEqual(expectedRemaining);
    }
  });

  it('no stripped furniture text (URL / page-navigation) survives into any extracted header field, on all six fixtures', () => {
    for (const id of ALL_LETTER_IDS) {
      const header = extractHeader(loadLetter(id).text);
      const values = collectStringValues(header);
      for (const value of values) {
        expect(value, `${id}: header field leaked furniture text`).not.toMatch(
          /ireps\.gov\.in|PublishedLetter|publishLOAWorksLetter/i,
        );
      }
    }
  });

  // The reviewer's own replicated leak probe (DC-23 review round 1),
  // re-run here as an independent negative proof: flatten exactly the input
  // header.ts's field regexes actually operate on (furniture-stripped text,
  // sliced to the header region, whitespace-collapsed) and scan THAT for a
  // leak — one level upstream of collectStringValues' per-field scan above,
  // so it would catch a leak even if some future field regex accidentally
  // "consumed" furniture text into a value instead of skipping past it.
  it('replicated leak probe: the flattened header INPUT (not just the extracted output) carries no ireps.gov.in or print-date, on all six fixtures', () => {
    const ITEM_TABLE_MARKER = 'Awarded Quantities And Rates';
    const printHeaderDateTimeRe =
      /\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*(AM|PM)/;
    for (const id of ALL_LETTER_IDS) {
      const { text } = loadLetter(id);
      const stripped = stripPrintFurniture(text);
      const markerIdx = stripped.indexOf(ITEM_TABLE_MARKER);
      const headerRegion = markerIdx === -1 ? stripped : stripped.slice(0, markerIdx);
      const flattenedHeaderInput = flatten(headerRegion);

      expect(flattenedHeaderInput, `${id}: flattened header input`).not.toContain(
        'ireps.gov.in',
      );
      expect(
        printHeaderDateTimeRe.test(flattenedHeaderInput),
        `${id}: flattened header input carries a print-date pattern`,
      ).toBe(false);
    }
  });

  it('the fixture files themselves are untouched (furniture noise stripped only at parse time)', () => {
    // The corpus's sha256 guard (corpus-manifest.test.ts) already proves this
    // at the byte level; this assertion documents the intent locally: raw
    // fixture text loaded via loadCorpus() still CONTAINS the furniture this
    // module strips in memory.
    for (const id of ALL_LETTER_IDS) {
      const { text } = loadLetter(id);
      expect(
        text.split('\n').some((l) => isPrintFurnitureLine(l)),
        `${id}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion: the split letter number is rejoined
// ---------------------------------------------------------------------------

describe('split letter-number rejoin', () => {
  it('PL273 yields exactly "JHANSI DIVISION-S AND T / JHS-N-W-71-25 / 00341490150678"', () => {
    const header = extractHeader(loadLetter('PL273-JHS').text);
    expect(header.letterNumber.value).toBe(
      'JHANSI DIVISION-S AND T / JHS-N-W-71-25 / 00341490150678',
    );
    expect(header.letterNumber.needsReview).toBe(false);
  });

  it('the interleaved Dated: line becomes the letter date (2026-02-09)', () => {
    const header = extractHeader(loadLetter('PL273-JHS').text);
    expect(header.letterDate.value).toBe('2026-02-09');
    expect(header.letterDate.needsReview).toBe(false);
  });

  it('pins the TRUNCATED value a naive line-wise regex produces, and asserts the real parser does not emit it', () => {
    const { text } = loadLetter('PL273-JHS');
    const stripped = stripPrintFurniture(text);

    // A naive line-wise regex — "." doesn't match "\n" without the "s" flag —
    // only sees the first physical line of the "Letter No:" field and
    // silently drops the continuation after the interleaved "Dated:" line.
    const naiveMatch = /Letter No:\s*(.+)/.exec(stripped);
    const naiveTruncatedValue = naiveMatch?.[1]?.trim();

    // Pin the exact trap value so a regression can't silently reintroduce it.
    expect(naiveTruncatedValue).toBe('JHANSI DIVISION-S AND T / JHS-N-');

    const header = extractHeader(text);
    expect(header.letterNumber.value).not.toBe(naiveTruncatedValue);
    expect(header.letterNumber.value).toBe(
      'JHANSI DIVISION-S AND T / JHS-N-W-71-25 / 00341490150678',
    );
  });

  it('rejoins correctly on all six fixtures: no trailing hyphen, no embedded "Dated:", well-formed <division> / <tender-code> / <serial>', () => {
    const expected: Record<string, string> = {
      'PL273-JHS': 'JHANSI DIVISION-S AND T / JHS-N-W-71-25 / 00341490150678',
      'PL280-ADI':
        'AHMEDABAD DIVISION-S AND T / DRM-SnT-ADI-Tele12of25-26 / 00341490157359',
      'PL275-BKN': 'BIKANER DIVISION-S AND T / SnT-BKN-25-26-26 / 00341490151147',
      'PL276-GTL': 'GUNTAKAL DIVISION-S AND T / 01-SNT-03-2026 / 00341490156039',
      'PL270-CRB': 'MUMBAI-CST-DIVISION-S AND T / CR-BB-TELE-2025-46 / 00341490147964',
      'PL281-BB':
        'MUMBAI CENTRAL DIVISION-S AND T / WR-MMCT-SnT-STTD-34-2025 / 00341490158364',
    };
    for (const id of ALL_LETTER_IDS) {
      const header = extractHeader(loadLetter(id).text);
      expect(header.letterNumber.value, id).toBe(expected[id]);
      expect(header.letterNumber.value, id).not.toMatch(/Dated\s*:/);
      expect(header.letterNumber.value, id).not.toMatch(/-$/);
      expect(header.letterNumber.needsReview, id).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion: nothing is discarded and nothing is guessed
// ---------------------------------------------------------------------------

describe('unlocatable field -> null + retained raw candidate + needsReview (never a partial value)', () => {
  it('deleting the letter-number block (Letter No: / Dated: / continuation lines) in-memory yields null + non-null raw + needsReview=true for both letterNumber and letterDate', () => {
    const { text } = loadLetter('PL273-JHS');
    const withoutBlock = deleteLetterNumberBlock(text);

    // Sanity: the transform actually removed the block (not a no-op) and did
    // not touch the fixture on disk.
    expect(withoutBlock).not.toContain('Letter No:');
    expect(withoutBlock).not.toContain('Dated:');
    expect(loadLetter('PL273-JHS').text).toContain('Letter No:');

    const header = extractHeader(withoutBlock);

    expect(header.letterNumber.value).toBeNull();
    expect(header.letterNumber.raw).not.toBeNull();
    expect(header.letterNumber.raw?.length).toBeGreaterThan(0);
    expect(header.letterNumber.needsReview).toBe(true);

    expect(header.letterDate.value).toBeNull();
    expect(header.letterDate.raw).not.toBeNull();
    expect(header.letterDate.needsReview).toBe(true);

    // Never a partial value: the truncated naive-regex value must not leak
    // through either.
    expect(header.letterNumber.value).not.toBe('JHANSI DIVISION-S AND T / JHS-N-');
  });

  it('a field genuinely absent from the source (PL276-GTL has no "Consignee:" header paragraph) is null + needsReview, not guessed', () => {
    const header = extractHeader(loadLetter('PL276-GTL').text);
    expect(header.consignee.value).toBeNull();
    expect(header.consignee.needsReview).toBe(true);
    // [m1, DC-23 review round 1]: even with no value, a candidate raw block
    // must be retained — the nearest related prose (PL276-GTL's "Incharges:"
    // paragraph, PL276-GTL.txt:76), not null-with-no-context.
    expect(header.consignee.raw).not.toBeNull();
    expect(header.consignee.raw).toContain('Incharges:');
  });

  it('the optional File No field is null WITHOUT needsReview when genuinely absent (5/6 letters) — absence is normal, not an anomaly', () => {
    for (const id of ALL_LETTER_IDS) {
      if (id === 'PL280-ADI') {
        continue;
      }
      const header = extractHeader(loadLetter(id).text);
      expect(header.fileNo.value, id).toBeNull();
      expect(header.fileNo.needsReview, id).toBe(false);
    }
  });

  it('File No is captured when present (PL280-ADI only)', () => {
    const header = extractHeader(loadLetter('PL280-ADI').text);
    expect(header.fileNo.value).toBe('Computer file no.713979 WR-ADI0SnT(STMC)/3/2026');
    expect(header.fileNo.needsReview).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterion: header/prose fields extracted (research §3)
// ---------------------------------------------------------------------------

describe('header/prose fields, all six letters', () => {
  it('zone, division, tender number, bid id, and contractor name are located on every fixture', () => {
    for (const id of ALL_LETTER_IDS) {
      const header = extractHeader(loadLetter(id).text);
      expect(header.zone.value, `${id}: zone`).not.toBeNull();
      expect(header.division.value, `${id}: division`).not.toBeNull();
      expect(header.officeAddress.value, `${id}: officeAddress`).not.toBeNull();
      expect(header.tenderNumber.value, `${id}: tenderNumber`).not.toBeNull();
      expect(header.tenderClosingDate.value, `${id}: tenderClosingDate`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(header.workDescription.value, `${id}: workDescription`).not.toBeNull();
      expect(header.bidId.value, `${id}: bidId`).not.toBeNull();
      expect(header.bidDate.value, `${id}: bidDate`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(header.contractorName.value, `${id}: contractorName`).not.toBeNull();
      expect(header.contractorAddress.value, `${id}: contractorAddress`).not.toBeNull();
      expect(header.signatoryName.value, `${id}: signatoryName`).not.toBeNull();
      expect(
        header.signatoryDesignation.value,
        `${id}: signatoryDesignation`,
      ).not.toBeNull();
    }
  });

  it('the letter-number-derived division agrees with the office-address-block division on all six letters', () => {
    for (const id of ALL_LETTER_IDS) {
      const header = extractHeader(loadLetter(id).text);
      const divisionFromLetterNumber = header.letterNumber.value?.split(' / ')[0];
      expect(header.division.value, id).toBe(divisionFromLetterNumber);
    }
  });

  it('PL270-CRB\'s wrap-broken division ("MUMBAI-CST-" / "DIVISION-S AND T") rejoins with no stray space, matching its own Letter No spelling', () => {
    const header = extractHeader(loadLetter('PL270-CRB').text);
    expect(header.division.value).toBe('MUMBAI-CST-DIVISION-S AND T');
  });

  it('signatory name/designation are read from the line pair immediately above "Digitally Signed"', () => {
    const expected: Record<string, [string, string]> = {
      'PL273-JHS': ['NARENDRA SINGH', 'Sr.DSTE/CO'],
      'PL280-ADI': ['VIKAS KUMAR', 'Sr.DSTE ADI'],
      'PL275-BKN': ['AKHIL GUPTA', 'ADSTEHSR'],
      'PL276-GTL': ['BOMMA CHANDRA SHEKHAR', 'Sr.DSTE/GTL'],
      'PL270-CRB': ['NISHANT K DWIVEDI', 'Sr.DSTE/Co'],
      'PL281-BB': ['ASHISH TIWARI', 'Sr.DSTE/Co./BCT'],
    };
    for (const id of ALL_LETTER_IDS) {
      const header = extractHeader(loadLetter(id).text);
      const [name, designation] = expected[id] as [string, string];
      expect(header.signatoryName.value, id).toBe(name);
      expect(header.signatoryDesignation.value, id).toBe(designation);
    }
  });

  it('GCC version: present in 4/6 letters (varying phrasing), genuinely absent (null + needsReview) in PL275-BKN, PL270-CRB, PL281-BB', () => {
    const header273 = extractHeader(loadLetter('PL273-JHS').text);
    expect(header273.gccVersion.value).toBe('GCC-2022');

    const header280 = extractHeader(loadLetter('PL280-ADI').text);
    expect(header280.gccVersion.value).toMatch(
      /General Condition of Contract APRIL-?\s*2022/,
    );

    const header276 = extractHeader(loadLetter('PL276-GTL').text);
    expect(header276.gccVersion.value).toBe('IRGCC April 2022');

    for (const id of ['PL275-BKN', 'PL270-CRB', 'PL281-BB'] as const) {
      const header = extractHeader(loadLetter(id).text);
      expect(header.gccVersion.value, id).toBeNull();
      expect(header.gccVersion.needsReview, id).toBe(true);
      // [m1, DC-23 review round 1]: retain a candidate raw block even with no
      // value — the security-deposit clause-reference sentence, the one place
      // in the template a GCC citation would appear if the letter carried
      // one, not null-with-no-context.
      expect(header.gccVersion.raw, id).not.toBeNull();
      expect(header.gccVersion.raw, id).toContain('in terms of');
    }
  });

  it("EMD amount + IREPS reference id, including PL270-CRB's two comma-separated reference ids", () => {
    const header273 = extractHeader(loadLetter('PL273-JHS').text);
    expect(header273.emd.amount).toBe(60900);
    expect(header273.emd.irepsReferenceId).toBe('PE443329448008');

    const header270 = extractHeader(loadLetter('PL270-CRB').text);
    expect(header270.emd.amount).toBe(1127900);
    expect(header270.emd.irepsReferenceId).toBe('PE514428316551, PE793028316475');
  });

  it('security-deposit percentages and clause reference, including a decimal clause number ("clause 16.1")', () => {
    const header = extractHeader(loadLetter('PL273-JHS').text);
    expect(header.securityDeposit.recoveryPercent).toBe(6);
    expect(header.securityDeposit.capPercent).toBe(5);
    // The clause-reference regex must not truncate at the decimal point
    // WITHIN the clause number itself.
    expect(header.securityDeposit.clauseReference).toBe('clause 16.1 of GCC-2022');
    expect(header.securityDeposit.needsReview).toBe(false);
  });

  it('performance guarantee: amount, submission window, extension, and penal interest', () => {
    const header = extractHeader(loadLetter('PL273-JHS').text);
    expect(header.performanceGuarantee.amountFigures).toBe(152321.33);
    expect(header.performanceGuarantee.submissionDays).toBe(21);
    expect(header.performanceGuarantee.extensionDays).toBe(60);
    expect(header.performanceGuarantee.penalInterestPercent).toBe(12);
    expect(header.performanceGuarantee.needsReview).toBe(false);
  });

  it('PL281-BB genuinely omits the penal-interest sentence: penalInterestPercent is null and needsReview is true, other PG fields still populated', () => {
    const header = extractHeader(loadLetter('PL281-BB').text);
    expect(header.performanceGuarantee.amountFigures).toBe(7376797.39);
    expect(header.performanceGuarantee.submissionDays).toBe(21);
    expect(header.performanceGuarantee.extensionDays).toBe(60);
    expect(header.performanceGuarantee.penalInterestPercent).toBeNull();
    expect(header.performanceGuarantee.needsReview).toBe(true);
  });

  it('completion period (value + unit) on all six letters', () => {
    const expected: Record<string, number> = {
      'PL273-JHS': 24,
      'PL280-ADI': 36,
      'PL275-BKN': 6,
      'PL276-GTL': 12,
      'PL270-CRB': 12,
      'PL281-BB': 108,
    };
    for (const id of ALL_LETTER_IDS) {
      const header = extractHeader(loadLetter(id).text);
      expect(header.completionPeriod.value, id).toBe(expected[id]);
      expect(header.completionPeriod.unit, id).toBe('month');
      expect(header.completionPeriod.needsReview, id).toBe(false);
    }
  });

  it('consignee and officer-in-charge are located wherever the letter states them, across both label-first and value-first sentence shapes', () => {
    const header275 = extractHeader(loadLetter('PL275-BKN').text); // label-first
    expect(header275.consignee.value).toBe('SSE/Tele/HSR');
    expect(header275.officerInCharge.value).toBe('ADSTE/HSR');

    const header281 = extractHeader(loadLetter('PL281-BB').text); // colon-labelled
    expect(header281.consignee.value).toBe('SSE/Tele/Store/BCT & Valsad');
    expect(header281.officerInCharge.value).toBe('ADSTE/Tele1/Mumbai Central');

    const header270 = extractHeader(loadLetter('PL270-CRB').text); // value-first, no "and" before it
    expect(header270.officerInCharge.value).toBe('Sr.DSTE/Co/BB');
  });

  // DC-23 review round 1 [M1, MAJOR]: PL273-JHS's officerInCharge snapshot
  // previously pinned "SSE/TELE/ML/JHS and SSE/TELE/GWL will be consignee and
  // DSTE/JHS & ADSTE/GWL" with needsReview:false — WRONG. The true value is
  // "DSTE/JHS & ADSTE/GWL" (raw: "...ADSTE/GWL will be the Officer incharge
  // of the work"): the value-first extraction's lazy capture group spanned
  // the PRECEDING, unrelated "...will be consignee..." clause instead of
  // stopping at it. Pinned here explicitly so a regression cannot silently
  // reintroduce the wrong value.
  it('PL273-JHS value-first officerInCharge does not bleed into the preceding unrelated "...will be consignee..." clause', () => {
    const header = extractHeader(loadLetter('PL273-JHS').text);
    expect(header.officerInCharge.value).toBe('DSTE/JHS & ADSTE/GWL');
    expect(header.officerInCharge.needsReview).toBe(false);
    // The trap value a naively-scoped capture group produces (measured, DC-23
    // review round 1) must never be emitted.
    expect(header.officerInCharge.value).not.toContain('will be consignee');
    expect(header.officerInCharge.value).not.toBe(
      'SSE/TELE/ML/JHS and SSE/TELE/GWL will be consignee and DSTE/JHS & ADSTE/GWL',
    );
  });

  // DC-23 review round 2 [R1]: the last-"and"-clause split has a dangerous
  // fail direction if left unguarded — reviewer-demonstrated synthetically by
  // mutating PL273-JHS's "&" (within the "DSTE/JHS & ADSTE/GWL" subject) to
  // the literal word "and". An unguarded split would then see THREE "and"
  // occurrences in the prefix and confidently take only the last fragment
  // ("ADSTE/GWL"), silently dropping "DSTE/JHS and " — a PARTIAL value with
  // needsReview:false. The guard (every discarded clause must itself contain
  // "will be", proving each split point separates two complete role-mapping
  // clauses) must catch this: two of the three discarded clauses here do NOT
  // contain "will be", so the guard falls back to the WHOLE prefix with
  // needsReview:true.
  it('R1: a literal "and" inside a value-first subject (not a role-mapping separator) falls back to the whole prefix, flagged for review — never a silently-truncated partial value', () => {
    const { text } = loadLetter('PL273-JHS');
    expect(text).toContain('DSTE/JHS & ADSTE/GWL will be the Officer incharge');

    // In-memory transform only — never touches the fixture on disk.
    const mutated = text.replace(
      'DSTE/JHS & ADSTE/GWL will be the Officer incharge',
      'DSTE/JHS and ADSTE/GWL will be the Officer incharge',
    );
    expect(mutated).not.toBe(text);
    expect(loadLetter('PL273-JHS').text).toContain('DSTE/JHS & ADSTE/GWL'); // fixture untouched

    const header = extractHeader(mutated);

    // The dangerous partial value the guard exists to prevent must never be
    // emitted, confidently or otherwise.
    expect(header.officerInCharge.value).not.toBe('ADSTE/GWL');

    // Nothing discarded: the whole prefix is retained verbatim...
    expect(header.officerInCharge.value).toContain('DSTE/JHS and ADSTE/GWL');
    expect(header.officerInCharge.value).toContain('SSE/TELE/GWL will be consignee');
    // ...and flagged, since the split points could not be proven safe.
    expect(header.officerInCharge.needsReview).toBe(true);
  });

  // DC-23 review round 1 [m2, documented policy — see isCompoundRoleProse in
  // header.ts]: a consignee paragraph naming exactly one role-holder is a
  // confidently-extracted single fact (needsReview: false); a paragraph
  // packing TWO OR MORE "<X> will be <role>" mappings into one string is
  // compound prose — retained verbatim (nothing discarded) but flagged for
  // review, since research §3's "consignee(s)" is plural and a single string
  // cannot itself say which role-holder(s) are the real consignee(s).
  it('consignee needsReview policy: a single role-mapping is confident, a compound (2+ "will be") paragraph is flagged for review', () => {
    // Single role-mapping -> confident.
    const header275 = extractHeader(loadLetter('PL275-BKN').text);
    expect(header275.consignee.needsReview).toBe(false);
    const header281 = extractHeader(loadLetter('PL281-BB').text);
    expect(header281.consignee.needsReview).toBe(false);

    // Compound (2+ "will be" role-mappings squeezed into the same paragraph)
    // -> flagged, but the FULL text is still retained (never discarded).
    const header273 = extractHeader(loadLetter('PL273-JHS').text);
    expect(header273.consignee.needsReview).toBe(true);
    expect(header273.consignee.value).not.toBeNull();
    expect(header273.consignee.value).toContain('DSTE/JHS & ADSTE/GWL');

    const header280 = extractHeader(loadLetter('PL280-ADI').text);
    expect(header280.consignee.needsReview).toBe(true);
    expect(header280.consignee.value).not.toBeNull();
    expect(header280.consignee.value).toContain('ADSTE/MSH');

    const header270 = extractHeader(loadLetter('PL270-CRB').text);
    expect(header270.consignee.needsReview).toBe(true);
    expect(header270.consignee.value).not.toBeNull();
    expect(header270.consignee.value).toContain('SSE/Tele/Stores/KYN');
  });
});

// ---------------------------------------------------------------------------
// Criterion: contract value figures vs words, mismatch -> needsReview
// ---------------------------------------------------------------------------

describe('contract value: figures + words, mismatch -> needsReview', () => {
  it('figures match the corpus manifest net_bid_value exactly, on all six letters', () => {
    for (const letter of loadCorpus()) {
      const header = extractHeader(letter.text);
      expect(header.contractValue.figures, letter.manifest.id).toBe(
        letter.manifest.net_bid_value,
      );
      expect(header.contractValue.words, letter.manifest.id).not.toBeNull();
      expect(header.contractValue.needsReview, letter.manifest.id).toBe(false);
    }
  });

  it('words-to-number parses the Indian lakh/crore grouping correctly (cross-checked against every real contract value in the corpus)', () => {
    expect(
      indianWordsToNumber(
        'Sixteen Crore Ninety-Two Lakh Twenty-Eight Thousand Four Hundred And Ninety-Seven',
      ),
    ).toBe(169228497);
    expect(indianWordsToNumber('Fourty-Six')).toBe(46); // IREPS's nonstandard "Fourty" spelling
    expect(indianWordsToNumber('Forty-Six')).toBe(46); // standard spelling also accepted
    expect(
      parseRupeesWords(
        'Rupees Thirty Lakh Fourty-Six Thousand Four Hundred And Twenty-Six Rupees And Fifty-Six Paise Only',
      ),
    ).toBe(3046426.56);
  });

  it('a figures/words MISMATCH raises needsReview and retains BOTH values — never silently picks one', () => {
    const { text } = loadLetter('PL273-JHS');
    // In-memory transform only: corrupt the FIGURES half of the contract
    // value while leaving the words phrase untouched, so the two halves
    // disagree. The real figure is 3046426.56 (words: "...Twenty-Six Rupees
    // And Fifty-Six Paise Only"); this substitutes a figure that does not
    // correspond to those words at all.
    const corrupted = text.replace(
      'works out to Rs. 3046426.56 (Rupees Thirty Lakh',
      'works out to Rs. 9999999.99 (Rupees Thirty Lakh',
    );
    expect(corrupted).not.toBe(text); // the transform actually changed something
    expect(loadLetter('PL273-JHS').text).toContain('works out to Rs. 3046426.56'); // fixture untouched

    const header = extractHeader(corrupted);
    expect(header.contractValue.figures).toBe(9999999.99);
    expect(header.contractValue.words).not.toBeNull();
    expect(header.contractValue.words).toContain('Twenty-Six');
    expect(header.contractValue.needsReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Criterion: dates DD/MM/YYYY -> YYYY-MM-DD strings, no Date-object/TZ path
// ---------------------------------------------------------------------------

describe('date normalisation: DD/MM/YYYY -> YYYY-MM-DD, no timezone-aware datetime', () => {
  it('parseDdMmYyyy handles both "/" and "-" separators, tolerant of stray whitespace from a print-layout wrap', () => {
    expect(parseDdMmYyyy('09/02/2026')).toBe('2026-02-09');
    expect(parseDdMmYyyy('15-01-2026')).toBe('2026-01-15');
    expect(parseDdMmYyyy('23-03- 2026')).toBe('2026-03-23'); // PL280-ADI's wrapped tender-closing-date
    expect(parseDdMmYyyy('not a date')).toBeNull();
  });

  it('every date field on every letter is a YYYY-MM-DD string, never a Date instance', () => {
    for (const id of ALL_LETTER_IDS) {
      const header = extractHeader(loadLetter(id).text);
      for (const field of [
        header.letterDate,
        header.tenderClosingDate,
        header.bidDate,
      ] as const) {
        expect(field.value, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof field.value, id).toBe('string');
      }
    }
  });

  it('TZ invariance: parsing under TZ=UTC and TZ=Asia/Kolkata produces byte-identical output (no Date object on the path)', () => {
    const runUnder = (tz: string): string => {
      vi.stubEnv('TZ', tz);
      try {
        const headers = loadCorpus().map((letter) => extractHeader(letter.text));
        return JSON.stringify(headers);
      } finally {
        vi.unstubAllEnvs();
      }
    };

    const underUtc = runUnder('UTC');
    const underKolkata = runUnder('Asia/Kolkata');
    expect(underKolkata).toBe(underUtc);
  });
});

// ---------------------------------------------------------------------------
// Criterion: all six fixtures parse their header without throwing; snapshot
// pins the full header object per letter.
// ---------------------------------------------------------------------------

describe('every fixture parses without throwing; snapshot pins the full header per letter', () => {
  for (const id of ALL_LETTER_IDS) {
    it(`${id} parses without throwing and matches its snapshot`, () => {
      const { text } = loadLetter(id);
      let header: LoaHeader | undefined;
      expect(() => {
        header = extractHeader(text);
      }).not.toThrow();
      expect(header).toMatchSnapshot();
    });
  }
});

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

/** Deletes the 3-line "Letter No: / Dated: / continuation" block from a
 * furniture-bearing fixture's raw text, in memory only — never edits the
 * fixture file. Used to prove the "unlocatable field -> null + raw +
 * needsReview" contract without a synthetic/fabricated fixture. */
function deleteLetterNumberBlock(text: string): string {
  const lines = text.split('\n');
  const letterNoIdx = lines.findIndex((l) => /Letter No\s*:/.test(l));
  if (letterNoIdx === -1) {
    throw new Error('test setup bug: fixture has no "Letter No:" line to delete');
  }
  // Locate the immediately-following "Dated:" line and the continuation line
  // after it (both non-blank, per the corpus's observed layout).
  let datedIdx = -1;
  for (let i = letterNoIdx + 1; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) {
      continue;
    }
    datedIdx = i;
    break;
  }
  if (datedIdx === -1 || !/Dated\s*:/.test(lines[datedIdx] ?? '')) {
    throw new Error('test setup bug: no "Dated:" line found after "Letter No:"');
  }
  let continuationIdx = -1;
  for (let i = datedIdx + 1; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) {
      continue;
    }
    continuationIdx = i;
    break;
  }
  if (continuationIdx === -1) {
    throw new Error('test setup bug: no continuation line found after "Dated:"');
  }
  const kept = lines.filter(
    (_, i) => i !== letterNoIdx && i !== datedIdx && i !== continuationIdx,
  );
  return kept.join('\n');
}

/** Recursively collects every string value out of a FieldResult-shaped
 * header object, for the furniture-leak scan. */
function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  return Object.values(value as Record<string, unknown>).flatMap(collectStringValues);
}
