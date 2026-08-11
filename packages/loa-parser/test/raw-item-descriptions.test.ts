import { describe, expect, it } from 'vitest';
import { parseItems, reviewLoaLetter } from '../src/index.js';

const layoutText = `Awarded Quantities And Rates
Schedule A1-Synthetic exact-description regression (Item Directory - Not Applicable)
1 First layout fragment S01 2 Numbers 5.00 At Par 10.00
shared physical line that layout gives to both neighbours
2 Second layout fragment S02 3 Metre 7.00 At Par 21.00
Schedule Totals 0.00
Total Value 31.00 0.00 %Below 31.00
Rebate on Total Value (%) 0.00
Net Bid Value 31.00
Item Breakup
No break up item added`;

const rawText = `Awarded Quantities And Rates
Item Sno.
Schedule A1-Synthetic exact-description regression (Item Directory - Not Applicable)
31.00
1 First exact line
continues before numeric tail
S01 2 Numbers 5.00 At Par 10.00
5/25/26, 2:40 PM ireps.gov.in/epsn/w orks/tds/publishLOAWorksLetter.do?Action=View
https://w w w.ireps.gov.in/epsn/w orks/tds/publishLOAWorksLetter.do?Action=View 1/2\f4 of tender document.
2 Second exact line
10 sq. mm stays prose
S02 3 Metre 7.00 At Par 21.00
Schedule Totals 0.00
Total Value 31.00 0.00 %Below 31.00`;

describe('raw item-description ownership', () => {
  it('replaces overlapping layout prose with exact disjoint rows', () => {
    const items = parseItems(layoutText, { rawItemText: rawText });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      schedule: { id: 'A1' },
      itemSno: '1',
      description:
        'First exact line continues before numeric tail 4 of tender document.',
      descriptionSource: 'raw-exact',
    });
    expect(items[1]).toMatchObject({
      schedule: { id: 'A1' },
      itemSno: '2',
      description: 'Second exact line 10 sq. mm stays prose',
      descriptionSource: 'raw-exact',
    });
    expect(items[0]?.description).not.toContain('Second exact line');
    expect(items[1]?.description).not.toContain('First exact line');
    expect(items[0]?.description).not.toContain('ireps.gov.in');
    expect(items[0]?.description).not.toContain('\f');
    expect(items[0]?.raw.exactDescriptionLines).toEqual([
      'First exact line',
      'continues before numeric tail',
      '4 of tender document.',
    ]);
  });

  it('keeps the conservative layout result and raises one letter review flag when the whole-row gate fails', () => {
    const mismatchedRaw = rawText.replace(
      'S02 3 Metre 7.00 At Par 21.00',
      'S02 3 Metre 7.00 At Par 22.00',
    );
    const payload = reviewLoaLetter(layoutText, { rawItemText: mismatchedRaw });

    expect(payload.items).toHaveLength(2);
    expect(
      payload.items.every((item) => item.descriptionSource === 'layout-overinclusive'),
    ).toBe(true);
    const descriptionFlags = payload.flags.filter(
      (flag) => flag.code === 'unresolved_item_description',
    );
    expect(descriptionFlags).toHaveLength(1);
    expect(descriptionFlags[0]?.scope).toBe('letter');
    expect(descriptionFlags[0]?.message).toContain(
      'Exact per-item description boundaries',
    );
  });

  it('keeps digit-leading prose equal to the current serial inside the description', () => {
    const digitLeadingRaw = rawText.replace(
      'continues before numeric tail',
      'continues before numeric tail\n1 mm cable remains prose',
    );
    const items = parseItems(layoutText, { rawItemText: digitLeadingRaw });

    expect(items.every((item) => item.descriptionSource === 'raw-exact')).toBe(true);
    expect(items[0]?.description).toContain('1 mm cable remains prose');
  });

  it('treats a next-page expected serial as the next row, not continuation prose', () => {
    const nextRowAtPageTop = rawText.replace(
      'https://w w w.ireps.gov.in/epsn/w orks/tds/publishLOAWorksLetter.do?Action=View 1/2\f4 of tender document.\n2 Second exact line',
      'https://w w w.ireps.gov.in/epsn/w orks/tds/publishLOAWorksLetter.do?Action=View 1/2\f2 Second exact line',
    );
    const items = parseItems(layoutText, { rawItemText: nextRowAtPageTop });

    expect(items[0]?.description).toBe(
      'First exact line continues before numeric tail',
    );
    expect(items[1]?.description).toBe('Second exact line 10 sq. mm stays prose');
    expect(items.every((item) => item.descriptionSource === 'raw-exact')).toBe(true);
  });
});
