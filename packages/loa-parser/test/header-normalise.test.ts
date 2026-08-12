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
// five â€” loadCorpus() is the source of truth (DC-22;
// docs/reference/loa-parser-contract.md Â§0). Every criterion below runs over
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
      // Every fixture repeats the header/footer once per printed page â€” both
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
  // lines" set through the same isPrintFurnitureLine predicate under test â€”
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
  // leak â€” one level upstream of collectStringValues' per-field scan above,
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

    // A naive line-wise regex â€” "." doesn't match "\n" without the "s" flag â€”
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
    // must be retained â€” the nearest related prose (PL276-GTL's "Incharges:"
    // paragraph, PL276-GTL.txt:76), not null-with-no-context.
    expect(header.consignee.raw).not.toBeNull();
    expect(header.consignee.raw).toContain('Incharges:');
  });

  it('the optional File No field is null WITHOUT needsReview when genuinely absent (5/6 letters) â€” absence is normal, not an anomaly', () => {
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
// Criterion: header/prose fields extracted (research Â§3)
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
      expect(header.contractorAddress.value, `${id}:×nx¶‰žËkºwµçUÍ”µÉ•™•É•¹”É••àµÕÍÐ¹½ÐÑÉÕ¹…Ñ”…ÐÑ¡”‘•¥µ…°Á½¥¹Ð(€€€€¼¼]%Q!%8Ñ¡”±…ÕÍ”¹Õµ‰•È¥ÑÍ•±˜¸(€€€•áÁ•Ð¡¡•…‘•È¹Í•ÕÉ¥Ñå•Á½Í¥Ð¹±…ÕÍ•I•™•É•¹”¤¹Ñ½	” ±…ÕÍ”€ÄØ¸Ä½˜´ÈÀÈÈœ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Í•ÕÉ¥Ñå•Á½Í¥Ð¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡™…±Í”¤ì(€ô¤ì((€¥Ð Á•É™½Éµ…¹”Õ…É…¹Ñ•”è…µ½Õ¹Ð°ÍÕ‰µ¥ÍÍ¥½¸Ý¥¹‘½Ü°•áÑ•¹Í¥½¸°…¹Á•¹…°¥¹Ñ•É•ÍÐœ°€ ¤€ôøì(€€€½¹ÍÐ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈÜÌµ)!Lœ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹…µ½Õ¹Ñ¥ÕÉ•Ì¤¹Ñ½	” ÄÔÈÌÈÄ¸ÌÌ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹ÍÕ‰µ¥ÍÍ¥½¹…åÌ¤¹Ñ½	” ÈÄ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹•áÑ•¹Í¥½¹…åÌ¤¹Ñ½	” ØÀ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹Á•¹…±%¹Ñ•É•ÍÑA•É•¹Ð¤¹Ñ½	” ÄÈ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡™…±Í”¤ì(€ô¤ì((€¥Ð A0ÈàÄµ	•¹Õ¥¹•±ä½µ¥ÑÌÑ¡”Á•¹…°µ¥¹Ñ•É•ÍÐÍ•¹Ñ•¹”èÁ•¹…±%¹Ñ•É•ÍÑA•É•¹Ð¥Ì¹Õ±°…¹¹••‘ÍI•Ù¥•Ü¥ÌÑÉÕ”°½Ñ¡•ÈA™¥•±‘ÌÍÑ¥±°Á½ÁÕ±…Ñ•œ°€ ¤€ôøì(€€€½¹ÍÐ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈàÄµ	œ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹…µ½Õ¹Ñ¥ÕÉ•Ì¤¹Ñ½	” ÜÌÜØÜäÜ¸Ìä¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹ÍÕ‰µ¥ÍÍ¥½¹…åÌ¤¹Ñ½	” ÈÄ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹•áÑ•¹Í¥½¹…åÌ¤¹Ñ½	” ØÀ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹Á•¹…±%¹Ñ•É•ÍÑA•É•¹Ð¤¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡ÑÉÕ”¤ì(€ô¤ì((€¥Ð ½µÁ±•Ñ¥½¸Á•É¥½€¡Ù…±Õ”€¬Õ¹¥Ð¤½¸…±°Í¥à±•ÑÑ•ÉÌœ°€ ¤€ôøì(€€€½¹ÍÐ•áÁ•Ñ•èI•½ÉñÍÑÉ¥¹œ°¹Õµ‰•Èø€ôì(€€€€€€A0ÈÜÌµ)!Lœè€ÈÐ°(€€€€€€A0ÈàÀµ$œè€ÌØ°(€€€€€€A0ÈÜÔµ	-8œè€Ø°(€€€€€€A0ÈÜØµQ0œè€ÄÈ°(€€€€€€A0ÈÜÀµIœè€ÄÈ°(€€€€€€A0ÈàÄµ	œè€ÄÀà°(€€€ôì(€€€™½È€¡½¹ÍÐ¥½˜11}1QQI}%L¤ì(€€€€€½¹ÍÐ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È¡¥¤¹Ñ•áÐ¤ì(€€€€€•áÁ•Ð¡¡•…‘•È¹½µÁ±•Ñ¥½¹A•É¥½¹Ù…±Õ”°¥¤¹Ñ½	”¡•áÁ•Ñ•‘m¥‘t¤ì(€€€€€•áÁ•Ð¡¡•…‘•È¹½µÁ±•Ñ¥½¹A•É¥½¹Õ¹¥Ð°¥¤¹Ñ½	” µ½¹Ñ œ¤ì(€€€€€•áÁ•Ð¡¡•…‘•È¹½µÁ±•Ñ¥½¹A•É¥½¹¹••‘ÍI•Ù¥•Ü°¥¤¹Ñ½	”¡™…±Í”¤ì(€€€ô(€ô¤ì((€¥Ð ½¹Í¥¹•”…¹½™™¥•Èµ¥¸µ¡…É”…É”±½…Ñ•Ý¡•É•Ù•ÈÑ¡”±•ÑÑ•ÈÍÑ…Ñ•ÌÑ¡•´°…É½ÍÌ‰½Ñ ±…‰•°µ™¥ÉÍÐ…¹Ù…±Õ”µ™¥ÉÍÐÍ•¹Ñ•¹”Í¡…Á•Ìœ°€ ¤€ôøì(€€€½¹ÍÐ¡•…‘•ÈÈÜÔ€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈÜÔµ	-8œ¤¹Ñ•áÐ¤ì€¼¼±…‰•°µ™¥ÉÍÐ(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÔ¹½¹Í¥¹•”¹Ù…±Õ”¤¹Ñ½	” MM½Q•±”½!MHœ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÔ¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹Ñ½	” MQ½!MHœ¤ì((€€€½¹ÍÐ¡•…‘•ÈÈàÄ€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈàÄµ	œ¤¹Ñ•áÐ¤ì€¼¼½±½¸µ±…‰•±±•(€€€•áÁ•Ð¡¡•…‘•ÈÈàÄ¹½¹Í¥¹•”¹Ù…±Õ”¤¹Ñ½	” MM½Q•±”½MÑ½É”½	P€˜Y…±Í…œ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈàÄ¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹Ñ½	” MQ½Q•±”Ä½5Õµ‰…¤•¹ÑÉ…°œ¤ì((€€€½¹ÍÐ¡•…‘•ÈÈÜÀ€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈÜÀµIœ¤¹Ñ•áÐ¤ì€¼¼Ù…±Õ”µ™¥ÉÍÐ°¹¼€‰…¹ˆ‰•™½É”¥Ð(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÀ¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹Ñ½	” MÈ¹MQ½¼½	œ¤ì(€ô¤ì((€€¼¼´ÈÌÉ•Ù¥•ÜÉ½Õ¹€Äm4Ä°5)=ItèA0ÈÜÌµ)!LÌ½™™¥•É%¹¡…É”Í¹…ÁÍ¡½Ð(€€¼¼ÁÉ•Ù¥½ÕÍ±äÁ¥¹¹•€‰MM½Q1½50½)!L…¹MM½Q1½]0Ý¥±°‰”½¹Í¥¹•”…¹(€€¼¼MQ½)!L€˜MQ½]0ˆÝ¥Ñ ¹••‘ÍI•Ù¥•Üé™…±Í”ƒŠP]I=9¸Q¡”ÑÉÕ”Ù…±Õ”¥Ì(€€¼¼€‰MQ½)!L€˜MQ½]0ˆ€¡É…Üè€ˆ¸¸¹MQ½]0Ý¥±°‰”Ñ¡”=™™¥•È¥¹¡…É”(€€¼¼½˜Ñ¡”Ý½É¬ˆ¤èÑ¡”Ù…±Õ”µ™¥ÉÍÐ•áÑÉ…Ñ¥½¸Ì±…éä…ÁÑÕÉ”É½ÕÀÍÁ…¹¹•(€€¼¼Ñ¡”AI%9°Õ¹É•±…Ñ•€ˆ¸¸¹Ý¥±°‰”½¹Í¥¹•”¸¸¸ˆ±…ÕÍ”¥¹ÍÑ•…½˜(€€¼¼ÍÑ½ÁÁ¥¹œ…Ð¥Ð¸A¥¹¹•¡•É”•áÁ±¥¥Ñ±äÍ¼„É•É•ÍÍ¥½¸…¹¹½ÐÍ¥±•¹Ñ±ä(€€¼¼É•¥¹ÑÉ½‘Õ”Ñ¡”ÝÉ½¹œÙ…±Õ”¸(€¥Ð A0ÈÜÌµ)!LÙ…±Õ”µ™¥ÉÍÐ½™™¥•É%¹¡…É”‘½•Ì¹½Ð‰±••¥¹Ñ¼Ñ¡”ÁÉ••‘¥¹œÕ¹É•±…Ñ•€ˆ¸¸¹Ý¥±°‰”½¹Í¥¹•”¸¸¸ˆ±…ÕÍ”œ°€ ¤€ôøì(€€€½¹ÍÐ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈÜÌµ)!Lœ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹Ñ½	” MQ½)!L€˜MQ½]0œ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹½™™¥•É%¹¡…É”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡™…±Í”¤ì(€€€€¼¼Q¡”ÑÉ…ÀÙ…±Õ”„¹…¥Ù•±äµÍ½Á•…ÁÑÕÉ”É½ÕÀÁÉ½‘Õ•Ì€¡µ•…ÍÕÉ•°´ÈÌ(€€€€¼¼É•Ù¥•ÜÉ½Õ¹€Ä¤µÕÍÐ¹•Ù•È‰”•µ¥ÑÑ•¸(€€€•áÁ•Ð¡¡•…‘•È¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹¹½Ð¹Ñ½½¹Ñ…¥¸ Ý¥±°‰”½¹Í¥¹•”œ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹¹½Ð¹Ñ½	” (€€€€€€MM½Q1½50½)!L…¹MM½Q1½]0Ý¥±°‰”½¹Í¥¹•”…¹MQ½)!L€˜MQ½]0œ°(€€€€¤ì(€ô¤ì((€€¼¼´ÈÌÉ•Ù¥•ÜÉ½Õ¹€ÈmHÅtèÑ¡”±…ÍÐ´‰…¹ˆµ±…ÕÍ”ÍÁ±¥Ð¡…Ì„‘…¹•É½ÕÌ(€€¼¼™…¥°‘¥É•Ñ¥½¸¥˜±•™ÐÕ¹Õ…É‘•ƒŠPÉ•Ù¥•Ý•Èµ‘•µ½¹ÍÑÉ…Ñ•Íå¹Ñ¡•Ñ¥…±±ä‰ä(€€¼¼µÕÑ…Ñ¥¹œA0ÈÜÌµ)!LÌ€ˆ˜ˆ€¡Ý¥Ñ¡¥¸Ñ¡”€‰MQ½)!L€˜MQ½]0ˆÍÕ‰©•Ð¤Ñ¼(€€¼¼Ñ¡”±¥Ñ•É…°Ý½É€‰…¹ˆ¸¸Õ¹Õ…É‘•ÍÁ±¥ÐÝ½Õ±Ñ¡•¸Í•”Q!I€‰…¹ˆ(€€¼¼½ÕÉÉ•¹•Ì¥¸Ñ¡”ÁÉ•™¥à…¹½¹™¥‘•¹Ñ±äÑ…­”½¹±äÑ¡”±…ÍÐ™É…µ•¹Ð(€€¼¼€ ‰MQ½]0ˆ¤°Í¥±•¹Ñ±ä‘É½ÁÁ¥¹œ€‰MQ½)!L…¹€ˆƒŠP„AIQ%0Ù…±Õ”Ý¥Ñ (€€¼¼¹••‘ÍI•Ù¥•Üé™…±Í”¸Q¡”Õ…É€¡•Ù•Éä‘¥Í…É‘•±…ÕÍ”µÕÍÐ¥ÑÍ•±˜½¹Ñ…¥¸(€€¼¼€‰Ý¥±°‰”ˆ°ÁÉ½Ù¥¹œ•… ÍÁ±¥ÐÁ½¥¹ÐÍ•Á…É…Ñ•ÌÑÝ¼½µÁ±•Ñ”É½±”µµ…ÁÁ¥¹œ(€€¼¼±…ÕÍ•Ì¤µÕÍÐ…Ñ Ñ¡¥ÌèÑÝ¼½˜Ñ¡”Ñ¡É•”‘¥Í…É‘•±…ÕÍ•Ì¡•É”‘¼9=P(€€¼¼½¹Ñ…¥¸€‰Ý¥±°‰”ˆ°Í¼Ñ¡”Õ…É™…±±Ì‰…¬Ñ¼Ñ¡”]!=1ÁÉ•™¥àÝ¥Ñ (€€¼¼¹••‘ÍI•Ù¥•ÜéÑÉÕ”¸(€¥Ð HÄè„±¥Ñ•É…°€‰…¹ˆ¥¹Í¥‘”„Ù…±Õ”µ™¥ÉÍÐÍÕ‰©•Ð€¡¹½Ð„É½±”µµ…ÁÁ¥¹œÍ•Á…É…Ñ½È¤™…±±Ì‰…¬Ñ¼Ñ¡”Ý¡½±”ÁÉ•™¥à°™±…•™½ÈÉ•Ù¥•ÜƒŠP¹•Ù•È„Í¥±•¹Ñ±äµÑÉÕ¹…Ñ•Á…ÉÑ¥…°Ù…±Õ”œ°€ ¤€ôøì(€€€½¹ÍÐìÑ•áÐô€ô±½…‘1•ÑÑ•È A0ÈÜÌµ)!Lœ¤ì(€€€•áÁ•Ð¡Ñ•áÐ¤¹Ñ½½¹Ñ…¥¸ MQ½)!L€˜MQ½]0Ý¥±°‰”Ñ¡”=™™¥•È¥¹¡…É”œ¤ì((€€€€¼¼%¸µµ•µ½ÉäÑÉ…¹Í™½É´½¹±äƒŠP¹•Ù•ÈÑ½Õ¡•ÌÑ¡”™¥áÑÕÉ”½¸‘¥Í¬¸(€€€½¹ÍÐµÕÑ…Ñ•€ôÑ•áÐ¹É•Á±…” (€€€€€€MQ½)!L€˜MQ½]0Ý¥±°‰”Ñ¡”=™™¥•È¥¹¡…É”œ°(€€€€€€MQ½)!L…¹MQ½]0Ý¥±°‰”Ñ¡”=™™¥•È¥¹¡…É”œ°(€€€€¤ì(€€€•áÁ•Ð¡µÕÑ…Ñ•¤¹¹½Ð¹Ñ½	”¡Ñ•áÐ¤ì(€€€•áÁ•Ð¡±½…‘1•ÑÑ•È A0ÈÜÌµ)!Lœ¤¹Ñ•áÐ¤¹Ñ½½¹Ñ…¥¸ MQ½)!L€˜MQ½]0œ¤ì€¼¼™¥áÑÕÉ”Õ¹Ñ½Õ¡•((€€€½¹ÍÐ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡µÕÑ…Ñ•¤ì((€€€€¼¼Q¡”‘…¹•É½ÕÌÁ…ÉÑ¥…°Ù…±Õ”Ñ¡”Õ…É•á¥ÍÑÌÑ¼ÁÉ•Ù•¹ÐµÕÍÐ¹•Ù•È‰”(€€€€¼¼•µ¥ÑÑ•°½¹™¥‘•¹Ñ±ä½È½Ñ¡•ÉÝ¥Í”¸(€€€•áÁ•Ð¡¡•…‘•È¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹¹½Ð¹Ñ½	” MQ½]0œ¤ì((€€€€¼¼9½Ñ¡¥¹œ‘¥Í…É‘•èÑ¡”Ý¡½±”ÁÉ•™¥à¥ÌÉ•Ñ…¥¹•Ù•É‰…Ñ¥´¸¸¸(€€€•áÁ•Ð¡¡•…‘•È¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹Ñ½½¹Ñ…¥¸ MQ½)!L…¹MQ½]0œ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹½™™¥•É%¹¡…É”¹Ù…±Õ”¤¹Ñ½½¹Ñ…¥¸ MM½Q1½]0Ý¥±°‰”½¹Í¥¹•”œ¤ì(€€€€¼¼€¸¸¹…¹™±…•°Í¥¹”Ñ¡”ÍÁ±¥ÐÁ½¥¹ÑÌ½Õ±¹½Ð‰”ÁÉ½Ù•¸Í…™”¸(€€€•áÁ•Ð¡¡•…‘•È¹½™™¥•É%¹¡…É”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡ÑÉÕ”¤ì(€ô¤ì((€€¼¼´ÈÌÉ•Ù¥•ÜÉ½Õ¹€Äm´È°‘½Õµ•¹Ñ•Á½±¥äƒŠPÍ•”¥Í½µÁ½Õ¹‘I½±•AÉ½Í”¥¸(€€¼¼¡•…‘•È¹ÑÍtè„½¹Í¥¹•”Á…É…É…Á ¹…µ¥¹œ•á…Ñ±ä½¹”É½±”µ¡½±‘•È¥Ì„(€€¼¼½¹™¥‘•¹Ñ±äµ•áÑÉ…Ñ•Í¥¹±”™…Ð€¡¹••‘ÍI•Ù¥•Üè™…±Í”¤ì„Á…É…É…Á (€€¼¼Á…­¥¹œQ]<=H5=I€ˆñ`øÝ¥±°‰”€ñÉ½±”øˆµ…ÁÁ¥¹Ì¥¹Ñ¼½¹”ÍÑÉ¥¹œ¥Ì(€€¼¼½µÁ½Õ¹ÁÉ½Í”ƒŠPÉ•Ñ…¥¹•Ù•É‰…Ñ¥´€¡¹½Ñ¡¥¹œ‘¥Í…É‘•¤‰ÕÐ™±…•™½È(€€¼¼É•Ù¥•Ü°Í¥¹”É•Í•…É ƒ
œÌÌ€‰½¹Í¥¹•”¡Ì¤ˆ¥ÌÁ±ÕÉ…°…¹„Í¥¹±”ÍÑÉ¥¹œ(€€¼¼…¹¹½Ð¥ÑÍ•±˜Í…äÝ¡¥ É½±”µ¡½±‘•È¡Ì¤…É”Ñ¡”É•…°½¹Í¥¹•”¡Ì¤¸(€¥Ð ½¹Í¥¹•”¹••‘ÍI•Ù¥•ÜÁ½±¥äè„Í¥¹±”É½±”µµ…ÁÁ¥¹œ¥Ì½¹™¥‘•¹Ð°„½µÁ½Õ¹€ È¬€‰Ý¥±°‰”ˆ¤Á…É…É…Á ¥Ì™±…•™½ÈÉ•Ù¥•Üœ°€ ¤€ôøì(€€€€¼¼M¥¹±”É½±”µµ…ÁÁ¥¹œ€´ø½¹™¥‘•¹Ð¸(€€€½¹ÍÐ¡•…‘•ÈÈÜÔ€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈÜÔµ	-8œ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÔ¹½¹Í¥¹•”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡™…±Í”¤ì(€€€½¹ÍÐ¡•…‘•ÈÈàÄ€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈàÄµ	œ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈàÄ¹½¹Í¥¹•”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡™…±Í”¤ì((€€€€¼¼½µÁ½Õ¹€ È¬€‰Ý¥±°‰”ˆÉ½±”µµ…ÁÁ¥¹ÌÍÅÕ••é•¥¹Ñ¼Ñ¡”Í…µ”Á…É…É…Á ¤(€€€€¼¼€´ø™±…•°‰ÕÐÑ¡”U10Ñ•áÐ¥ÌÍÑ¥±°É•Ñ…¥¹•€¡¹•Ù•È‘¥Í…É‘•¤¸(€€€½¹ÍÐ¡•…‘•ÈÈÜÌ€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈÜÌµ)!Lœ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÌ¹½¹Í¥¹•”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÌ¹½¹Í¥¹•”¹Ù…±Õ”¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÌ¹½¹Í¥¹•”¹Ù…±Õ”¤¹Ñ½½¹Ñ…¥¸ MQ½)!L€˜MQ½]0œ¤ì((€€€½¹ÍÐ¡•…‘•ÈÈàÀ€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈàÀµ$œ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈàÀ¹½¹Í¥¹•”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈàÀ¹½¹Í¥¹•”¹Ù…±Õ”¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈàÀ¹½¹Í¥¹•”¹Ù…±Õ”¤¹Ñ½½¹Ñ…¥¸ MQ½5M œ¤ì((€€€½¹ÍÐ¡•…‘•ÈÈÜÀ€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È A0ÈÜÀµIœ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÀ¹½¹Í¥¹•”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÀ¹½¹Í¥¹•”¹Ù…±Õ”¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡¡•…‘•ÈÈÜÀ¹½¹Í¥¹•”¹Ù…±Õ”¤¹Ñ½½¹Ñ…¥¸ MM½Q•±”½MÑ½É•Ì½-e8œ¤ì(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼É¥Ñ•É¥½¸è½¹ÑÉ…ÐÙ…±Õ”™¥ÕÉ•ÌÙÌÝ½É‘Ì°µ¥Íµ…Ñ €´ø¹••‘ÍI•Ù¥•Ü(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” ½¹ÑÉ…ÐÙ…±Õ”è™¥ÕÉ•Ì€¬Ý½É‘Ì°µ¥Íµ…Ñ €´ø¹••‘ÍI•Ù¥•Üœ°€ ¤€ôøì(€¥Ð ™¥ÕÉ•Ìµ…Ñ Ñ¡”½ÉÁÕÌµ…¹¥™•ÍÐ¹•Ñ}‰¥‘}Ù…±Õ”•á…Ñ±ä°½¸…±°Í¥à±•ÑÑ•ÉÌœ°€ ¤€ôøì(€€€™½È€¡½¹ÍÐ±•ÑÑ•È½˜±½…‘½ÉÁÕÌ ¤¤ì(€€€€€½¹ÍÐ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡±•ÑÑ•È¹Ñ•áÐ¤ì(€€€€€•áÁ•Ð¡¡•…‘•È¹½¹ÑÉ…ÑY…±Õ”¹™¥ÕÉ•Ì°±•ÑÑ•È¹µ…¹¥™•ÍÐ¹¥¤¹Ñ½	” (€€€€€€€±•ÑÑ•È¹µ…¹¥™•ÍÐ¹¹•Ñ}‰¥‘}Ù…±Õ”°(€€€€€€¤ì(€€€€€•áÁ•Ð¡¡•…‘•È¹½¹ÑÉ…ÑY…±Õ”¹Ý½É‘Ì°±•ÑÑ•È¹µ…¹¥™•ÍÐ¹¥¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€€€•áÁ•Ð¡¡•…‘•È¹½¹ÑÉ…ÑY…±Õ”¹¹••‘ÍI•Ù¥•Ü°±•ÑÑ•È¹µ…¹¥™•ÍÐ¹¥¤¹Ñ½	”¡™…±Í”¤ì(€€€ô(€ô¤ì((€¥Ð Ý½É‘ÌµÑ¼µ¹Õµ‰•ÈÁ…ÉÍ•ÌÑ¡”%¹‘¥…¸±…­ ½É½É”É½ÕÁ¥¹œ½ÉÉ•Ñ±ä€¡É½ÍÌµ¡•­•……¥¹ÍÐ•Ù•ÉäÉ•…°½¹ÑÉ…ÐÙ…±Õ”¥¸Ñ¡”½ÉÁÕÌ¤œ°€ ¤€ôøì(€€€•áÁ•Ð (€€€€€¥¹‘¥…¹]½É‘ÍQ½9Õµ‰•È (€€€€€€€€M¥áÑ••¸É½É”9¥¹•ÑäµQÝ¼1…­ QÝ•¹Ñäµ¥¡ÐQ¡½ÕÍ…¹½ÕÈ!Õ¹‘É•¹9¥¹•ÑäµM•Ù•¸œ°(€€€€€€¤°(€€€€¤¹Ñ½	” ÄØäÈÈàÐäÜ¤ì(€€€•áÁ•Ð¡¥¹‘¥…¹]½É‘ÍQ½9Õµ‰•È ½ÕÉÑäµM¥àœ¤¤¹Ñ½	” ÐØ¤ì€¼¼%IALÌ¹½¹ÍÑ…¹‘…É€‰½ÕÉÑäˆÍÁ•±±¥¹œ(€€€•áÁ•Ð¡¥¹‘¥…¹]½É‘ÍQ½9Õµ‰•È ½ÉÑäµM¥àœ¤¤¹Ñ½	” ÐØ¤ì€¼¼ÍÑ…¹‘…ÉÍÁ•±±¥¹œ…±Í¼…•ÁÑ•(€€€•áÁ•Ð (€€€€€Á…ÉÍ•IÕÁ••Í]½É‘Ì (€€€€€€€€IÕÁ••ÌQ¡¥ÉÑä1…­ ½ÕÉÑäµM¥àQ¡½ÕÍ…¹½ÕÈ!Õ¹‘É•¹QÝ•¹ÑäµM¥àIÕÁ••Ì¹¥™ÑäµM¥àA…¥Í”=¹±äœ°(€€€€€€¤°(€€€€¤¹Ñ½	” ÌÀÐØÐÈØ¸ÔØ¤ì(€ô¤ì((€¥Ð „™¥ÕÉ•Ì½Ý½É‘Ì5%M5Q É…¥Í•Ì¹••‘ÍI•Ù¥•Ü…¹É•Ñ…¥¹Ì	=Q Ù…±Õ•ÌƒŠP¹•Ù•ÈÍ¥±•¹Ñ±äÁ¥­Ì½¹”œ°€ ¤€ôøì(€€€½¹ÍÐìÑ•áÐô€ô±½…‘1•ÑÑ•È A0ÈÜÌµ)!Lœ¤ì(€€€€¼¼%¸µµ•µ½ÉäÑÉ…¹Í™½É´½¹±äè½ÉÉÕÁÐÑ¡”%UIL¡…±˜½˜Ñ¡”½¹ÑÉ…Ð(€€€€¼¼Ù…±Õ”Ý¡¥±”±•…Ù¥¹œÑ¡”Ý½É‘ÌÁ¡É…Í”Õ¹Ñ½Õ¡•°Í¼Ñ¡”ÑÝ¼¡…±Ù•Ì(€€€€¼¼‘¥Í…É•”¸Q¡”É•…°™¥ÕÉ”¥Ì€ÌÀÐØÐÈØ¸ÔØ€¡Ý½É‘Ìè€ˆ¸¸¹QÝ•¹ÑäµM¥àIÕÁ••Ì(€€€€¼¼¹¥™ÑäµM¥àA…¥Í”=¹±äˆ¤ìÑ¡¥ÌÍÕ‰ÍÑ¥ÑÕÑ•Ì„™¥ÕÉ”Ñ¡…Ð‘½•Ì¹½Ð(€€€€¼¼½ÉÉ•ÍÁ½¹Ñ¼Ñ¡½Í”Ý½É‘Ì…Ð…±°¸(€€€½¹ÍÐ½ÉÉÕÁÑ•€ôÑ•áÐ¹É•Á±…” (€€€€€€Ý½É­Ì½ÕÐÑ¼IÌ¸€ÌÀÐØÐÈØ¸ÔØ€¡IÕÁ••ÌQ¡¥ÉÑä1…­ œ°(€€€€€€Ý½É­Ì½ÕÐÑ¼IÌ¸€äääääää¸ää€¡IÕÁ••ÌQ¡¥ÉÑä1…­ œ°(€€€€¤ì(€€€•áÁ•Ð¡½ÉÉÕÁÑ•¤¹¹½Ð¹Ñ½	”¡Ñ•áÐ¤ì€¼¼Ñ¡”ÑÉ…¹Í™½É´…ÑÕ…±±ä¡…¹•Í½µ•Ñ¡¥¹œ(€€€•áÁ•Ð¡±½…‘1•ÑÑ•È A0ÈÜÌµ)!Lœ¤¹Ñ•áÐ¤¹Ñ½½¹Ñ…¥¸ Ý½É­Ì½ÕÐÑ¼IÌ¸€ÌÀÐØÐÈØ¸ÔØœ¤ì€¼¼™¥áÑÕÉ”Õ¹Ñ½Õ¡•((€€€½¹ÍÐ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡½ÉÉÕÁÑ•¤ì(€€€•áÁ•Ð¡¡•…‘•È¹½¹ÑÉ…ÑY…±Õ”¹™¥ÕÉ•Ì¤¹Ñ½	” äääääää¸ää¤ì(€€€•áÁ•Ð¡¡•…‘•È¹½¹ÑÉ…ÑY…±Õ”¹Ý½É‘Ì¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹½¹ÑÉ…ÑY…±Õ”¹Ý½É‘Ì¤¹Ñ½½¹Ñ…¥¸ QÝ•¹ÑäµM¥àœ¤ì(€€€•áÁ•Ð¡¡•…‘•È¹½¹ÑÉ…ÑY…±Õ”¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½	”¡ÑÉÕ”¤ì(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼É¥Ñ•É¥½¸è‘…Ñ•Ì½54½eeed€´øeeedµ54µÍÑÉ¥¹Ì°¹¼…Ñ”µ½‰©•Ð½QhÁ…Ñ (¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” ‘…Ñ”¹½Éµ…±¥Í…Ñ¥½¸è½54½eeed€´øeeedµ54µ°¹¼Ñ¥µ•é½¹”µ…Ý…É”‘…Ñ•Ñ¥µ”œ°€ ¤€ôøì(€¥Ð Á…ÉÍ•‘5µeååä¡…¹‘±•Ì‰½Ñ €ˆ¼ˆ…¹€ˆ´ˆÍ•Á…É…Ñ½ÉÌ°Ñ½±•É…¹Ð½˜ÍÑÉ…äÝ¡¥Ñ•ÍÁ…”™É½´„ÁÉ¥¹Ðµ±…å½ÕÐÝÉ…Àœ°€ ¤€ôøì(€€€•áÁ•Ð¡Á…ÉÍ•‘5µeååä œÀä¼ÀÈ¼ÈÀÈØœ¤¤¹Ñ½	” œÈÀÈØ´ÀÈ´Àäœ¤ì(€€€•áÁ•Ð¡Á…ÉÍ•‘5µeååä œÄÔ´ÀÄ´ÈÀÈØœ¤¤¹Ñ½	” œÈÀÈØ´ÀÄ´ÄÔœ¤ì(€€€•áÁ•Ð¡Á…ÉÍ•‘5µeååä œÈÌ´ÀÌ´€ÈÀÈØœ¤¤¹Ñ½	” œÈÀÈØ´ÀÌ´ÈÌœ¤ì€¼¼A0ÈàÀµ$ÌÝÉ…ÁÁ•Ñ•¹‘•Èµ±½Í¥¹œµ‘…Ñ”(€€€•áÁ•Ð¡Á…ÉÍ•‘5µeååä ¹½Ð„‘…Ñ”œ¤¤¹Ñ½	•9Õ±° ¤ì(€ô¤ì((€¥Ð •Ù•Éä‘…Ñ”™¥•±½¸•Ù•Éä±•ÑÑ•È¥Ì„eeedµ54µÍÑÉ¥¹œ°¹•Ù•È„…Ñ”¥¹ÍÑ…¹”œ°€ ¤€ôøì(€€€™½È€¡½¹ÍÐ¥½˜11}1QQI}%L¤ì(€€€€€½¹ÍÐ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡±½…‘1•ÑÑ•È¡¥¤¹Ñ•áÐ¤ì(€€€€€™½È€¡½¹ÍÐ™¥•±½˜l(€€€€€€€¡•…‘•È¹±•ÑÑ•É…Ñ”°(€€€€€€€¡•…‘•È¹Ñ•¹‘•É±½Í¥¹…Ñ”°(€€€€€€€¡•…‘•È¹‰¥‘…Ñ”°(€€€€€t…Ì½¹ÍÐ¤ì(€€€€€€€•áÁ•Ð¡™¥•±¹Ù…±Õ”°¥¤¹Ñ½5…Ñ  ½yq‘ìÑôµq‘ìÉôµq‘ìÉô¼¤ì(€€€€€€€•áÁ•Ð¡ÑåÁ•½˜™¥•±¹Ù…±Õ”°¥¤¹Ñ½	” ÍÑÉ¥¹œœ¤ì(€€€€€ô(€€€ô(€ô¤ì((€¥Ð Qh¥¹Ù…É¥…¹”èÁ…ÉÍ¥¹œÕ¹‘•ÈQhõUQ…¹QhõÍ¥„½-½±­…Ñ„ÁÉ½‘Õ•Ì‰åÑ”µ¥‘•¹Ñ¥…°½ÕÑÁÕÐ€¡¹¼…Ñ”½‰©•Ð½¸Ñ¡”Á…Ñ ¤œ°€ ¤€ôøì(€€€½¹ÍÐÉÕ¹U¹‘•È€ô€¡ÑèèÍÑÉ¥¹œ¤èÍÑÉ¥¹œ€ôøì(€€€€€Ù¤¹ÍÑÕ‰¹Ø Qhœ°Ñè¤ì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐ¡•…‘•ÉÌ€ô±½…‘½ÉÁÕÌ ¤¹µ…À ¡±•ÑÑ•È¤€ôø•áÑÉ…Ñ!•…‘•È¡±•ÑÑ•È¹Ñ•áÐ¤¤ì(€€€€€€€É•ÑÕÉ¸)M=8¹ÍÑÉ¥¹¥™ä¡¡•…‘•ÉÌ¤ì(€€€€€ô™¥¹…±±äì(€€€€€€€Ù¤¹Õ¹ÍÑÕ‰±±¹ÙÌ ¤ì(€€€€€ô(€€€ôì((€€€½¹ÍÐÕ¹‘•ÉUÑŒ€ôÉÕ¹U¹‘•È UQœ¤ì(€€€½¹ÍÐÕ¹‘•É-½±­…Ñ„€ôÉÕ¹U¹‘•È Í¥„½-½±­…Ñ„œ¤ì(€€€•áÁ•Ð¡Õ¹‘•É-½±­…Ñ„¤¹Ñ½	”¡Õ¹‘•ÉUÑŒ¤ì(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼É¥Ñ•É¥½¸è…±°Í¥à™¥áÑÕÉ•ÌÁ…ÉÍ”Ñ¡•¥È¡•…‘•ÈÝ¥Ñ¡½ÕÐÑ¡É½Ý¥¹œìÍ¹…ÁÍ¡½Ð(¼¼Á¥¹ÌÑ¡”™Õ±°¡•…‘•È½‰©•ÐÁ•È±•ÑÑ•È¸(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” •Ù•Éä™¥áÑÕÉ”Á…ÉÍ•ÌÝ¥Ñ¡½ÕÐÑ¡É½Ý¥¹œìÍ¹…ÁÍ¡½ÐÁ¥¹ÌÑ¡”™Õ±°¡•…‘•ÈÁ•È±•ÑÑ•Èœ°€ ¤€ôøì(€™½È€¡½¹ÍÐ¥½˜11}1QQI}%L¤ì(€€€¥Ð¡€‘í¥‘ôÁ…ÉÍ•ÌÝ¥Ñ¡½ÕÐÑ¡É½Ý¥¹œ…¹µ…Ñ¡•Ì¥ÑÌÍ¹…ÁÍ¡½Ñ€°€ ¤€ôøì(€€€€€½¹ÍÐìÑ•áÐô€ô±½…‘1•ÑÑ•È¡¥¤ì(€€€€€±•Ð¡•…‘•Èè1½…!•…‘•ÈðÕ¹‘•™¥¹•ì(€€€€€•áÁ•Ð  ¤€ôøì(€€€€€€€¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡Ñ•áÐ¤ì(€€€€€ô¤¹¹½Ð¹Ñ½Q¡É½Ü ¤ì(€€€€€•áÁ•Ð¡¡•…‘•È¤¹Ñ½5…Ñ¡M¹…ÁÍ¡½Ð ¤ì(€€€ô¤ì(€ô)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼Ñ•ÍÐ¡•±Á•ÉÌ(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((¼¨¨•±•Ñ•ÌÑ¡”€Ìµ±¥¹”€‰1•ÑÑ•È9¼è€¼…Ñ•è€¼½¹Ñ¥¹Õ…Ñ¥½¸ˆ‰±½¬™É½´„(€¨™ÕÉ¹¥ÑÕÉ”µ‰•…É¥¹œ™¥áÑÕÉ”ÌÉ…ÜÑ•áÐ°¥¸µ•µ½Éä½¹±äƒŠP¹•Ù•È•‘¥ÑÌÑ¡”(€¨™¥áÑÕÉ”™¥±”¸UÍ•Ñ¼ÁÉ½Ù”Ñ¡”€‰Õ¹±½…Ñ…‰±”™¥•±€´ø¹Õ±°€¬É…Ü€¬(€¨¹••‘ÍI•Ù¥•Üˆ½¹ÑÉ…ÐÝ¥Ñ¡½ÕÐ„Íå¹Ñ¡•Ñ¥Œ½™…‰É¥…Ñ•™¥áÑÕÉ”¸€¨¼)™Õ¹Ñ¥½¸‘•±•Ñ•1•ÑÑ•É9Õµ‰•É	±½¬¡Ñ•áÐèÍÑÉ¥¹œ¤èÍÑÉ¥¹œì(€½¹ÍÐ±¥¹•Ì€ôÑ•áÐ¹ÍÁ±¥Ð q¸œ¤ì(€½¹ÍÐ±•ÑÑ•É9½%‘à€ô±¥¹•Ì¹™¥¹‘%¹‘•à ¡°¤€ôø€½1•ÑÑ•È9½qÌ¨è¼¹Ñ•ÍÐ¡°¤¤ì(€¥˜€¡±•ÑÑ•É9½%‘à€ôôô€´Ä¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•ÍÐÍ•ÑÕÀ‰Õœè™¥áÑÕÉ”¡…Ì¹¼€‰1•ÑÑ•È9¼èˆ±¥¹”Ñ¼‘•±•Ñ”œ¤ì(€ô(€€¼¼1½…Ñ”Ñ¡”¥µµ•‘¥…Ñ•±äµ™½±±½Ý¥¹œ€‰…Ñ•èˆ±¥¹”…¹Ñ¡”½¹Ñ¥¹Õ…Ñ¥½¸±¥¹”(€€¼¼…™Ñ•È¥Ð€¡‰½Ñ ¹½¸µ‰±…¹¬°Á•ÈÑ¡”½ÉÁÕÌÌ½‰Í•ÉÙ•±…å½ÕÐ¤¸(€±•Ð‘…Ñ•‘%‘à€ô€´Äì(€™½È€¡±•Ð¤€ô±•ÑÑ•É9½%‘à€¬€Äì¤€ð±¥¹•Ì¹±•¹Ñ ì¤€¬ô€Ä¤ì(€€€½¹ÍÐ±¥¹”€ô€¡±¥¹•Ím¥t€üü€œœ¤¹ÑÉ¥´ ¤ì(€€€¥˜€¡±¥¹”¹±•¹Ñ €ôôô€À¤ì(€€€€€½¹Ñ¥¹Õ”ì(€€€ô(€€€‘…Ñ•‘%‘à€ô¤ì(€€€‰É•…¬ì(€ô(€¥˜€¡‘…Ñ•‘%‘à€ôôô€´Äñð€„½…Ñ•‘qÌ¨è¼¹Ñ•ÍÐ¡±¥¹•Ím‘…Ñ•‘%‘át€üü€œœ¤¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•ÍÐÍ•ÑÕÀ‰Õœè¹¼€‰…Ñ•èˆ±¥¹”™½Õ¹…™Ñ•È€‰1•ÑÑ•È9¼èˆœ¤ì(€ô(€±•Ð½¹Ñ¥¹Õ…Ñ¥½¹%‘à€ô€´Äì(€™½È€¡±•Ð¤€ô‘…Ñ•‘%‘à€¬€Äì¤€ð±¥¹•Ì¹±•¹Ñ ì¤€¬ô€Ä¤ì(€€€½¹ÍÐ±¥¹”€ô€¡±¥¹•Ím¥t€üü€œœ¤¹ÑÉ¥´ ¤ì(€€€¥˜€¡±¥¹”¹±•¹Ñ €ôôô€À¤ì(€€€€€½¹Ñ¥¹Õ”ì(€€€ô(€€€½¹Ñ¥¹Õ…Ñ¥½¹%‘à€ô¤ì(€€€‰É•…¬ì(€ô(€¥˜€¡½¹Ñ¥¹Õ…Ñ¥½¹%‘à€ôôô€´Ä¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•ÍÐÍ•ÑÕÀ‰Õœè¹¼½¹Ñ¥¹Õ…Ñ¥½¸±¥¹”™½Õ¹…™Ñ•È€‰…Ñ•èˆœ¤ì(€ô(€½¹ÍÐ­•ÁÐ€ô±¥¹•Ì¹™¥±Ñ•È (€€€€¡|°¤¤€ôø¤€„ôô±•ÑÑ•É9½%‘à€˜˜¤€„ôô‘…Ñ•‘%‘à€˜˜¤€„ôô½¹Ñ¥¹Õ…Ñ¥½¹%‘à°(€€¤ì(€É•ÑÕÉ¸­•ÁÐ¹©½¥¸ q¸œ¤ì)ô((¼¨¨I•ÕÉÍ¥Ù•±ä½±±•ÑÌ•Ù•ÉäÍÑÉ¥¹œÙ…±Õ”½ÕÐ½˜„¥•±‘I•ÍÕ±ÐµÍ¡…Á•(€¨¡•…‘•È½‰©•Ð°™½ÈÑ¡”™ÕÉ¹¥ÑÕÉ”µ±•…¬Í…¸¸€¨¼)™Õ¹Ñ¥½¸½±±•ÑMÑÉ¥¹Y…±Õ•Ì¡Ù…±Õ”èÕ¹­¹½Ý¸¤èÍÑÉ¥¹mtì(€¥˜€¡ÑåÁ•½˜Ù…±Õ”€ôôô€ÍÑÉ¥¹œœ¤ì(€€€É•ÑÕÉ¸mÙ…±Õ•tì(€ô(€¥˜€¡Ù…±Õ”€ôôô¹Õ±°ñðÑåÁ•½˜Ù…±Õ”€„ôô€½‰©•Ðœ¤ì(€€€É•ÑÕÉ¸mtì(€ô(€É•ÑÕÉ¸=‰©•Ð¹Ù…±Õ•Ì¡Ù…±Õ”…ÌI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½Ý¸ø¤¹™±…Ñ5…À¡½±±•ÑMÑÉ¥¹Y…±Õ•Ì¤ì)ô