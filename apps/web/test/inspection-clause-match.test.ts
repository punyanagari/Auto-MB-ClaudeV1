import { describe, expect, it } from 'vitest';
import {
  approximateDistance,
  normaliseForMatch,
  proposeInspectionAgency,
} from '../src/lib/inspection-clause-match.js';

/**
 * The clause tab's reading of an item description.
 *
 * These cases are the two failures the reading exists for — a typed
 * spelling mistake and words run together by a wrapped PDF cell — plus
 * the negatives that stop it proposing a clause on an ordinary supply
 * line.
 */
describe('proposeInspectionAgency', () => {
  it('reads the two clean phrasings', () => {
    expect(proposeInspectionAgency('Inspection by RDSO')).toBe('RDSO');
    expect(proposeInspectionAgency('Inspection by RITES')).toBe('RITES');
  });

  it('reads them inside a real schedule line, in either order', () => {
    expect(
      proposeInspectionAgency(
        'Supply of 42U floor mounted rack as per specification, inspection by RDSO at vendor works',
      ),
    ).toBe('RDSO');
    expect(
      proposeInspectionAgency('RITES inspection at the manufacturer’s premises'),
    ).toBe('RITES');
  });

  it('tolerates the spelling mistakes the corpus actually carries', () => {
    // The transposition an operator makes typing the word quickly.
    expect(proposeInspectionAgency('Insepction by RDSO')).toBe('RDSO');
    // One letter wrong in the acronym.
    expect(proposeInspectionAgency('Inspection by RDS0')).toBe('RDSO');
    expect(proposeInspectionAgency('Inspection by RITSE')).toBe('RITES');
    // Past tense and present participle, which the stem covers.
    expect(proposeInspectionAgency('To be inspected by RDSO before despatch')).toBe(
      'RDSO',
    );
    expect(proposeInspectionAgency('Items awaiting inspecting by RITES')).toBe('RITES');
  });

  it('tolerates joined words and punctuation inside the acronym', () => {
    expect(proposeInspectionAgency('inspectionbyRDSO')).toBe('RDSO');
    expect(proposeInspectionAgency('Inspection by R.D.S.O.')).toBe('RDSO');
    expect(proposeInspectionAgency('INSPECTION-BY-RITES')).toBe('RITES');
    expect(proposeInspectionAgency('Supply\nand\ninspection\nby\nRITES')).toBe('RITES');
  });

  it('proposes nothing for an ordinary supply line', () => {
    expect(proposeInspectionAgency('Supply of 2 core armoured cable, 1.5 sq mm')).toBe(
      null,
    );
    expect(
      proposeInspectionAgency('Laying of cable in trench including backfill'),
    ).toBe(null);
    expect(proposeInspectionAgency('')).toBe(null);
  });

  it('proposes nothing when only one half of the phrase is present', () => {
    // The agency's name with no inspection stem: an approval reference,
    // not a clause.
    expect(proposeInspectionAgency('RDSO approved make')).toBe(null);
    // The stem with no agency: a consignee inspection, which is the
    // value the operator reaches for when nothing is proposed.
    expect(proposeInspectionAgency('Inspection at site by the consignee')).toBe(null);
  });

  it('proposes the closer spelling when a line names both', () => {
    expect(proposeInspectionAgency('Inspection by RDSO or RITES')).toBe('RDSO');
    // RITES spelled exactly, RDSO one edit away: the closer one wins.
    expect(proposeInspectionAgency('Inspection by RDS0 / RITES')).toBe('RITES');
  });
});

describe('normaliseForMatch', () => {
  it('deletes separators rather than collapsing them, so joins and splits agree', () => {
    expect(normaliseForMatch('Inspection by R.D.S.O.')).toBe('inspectionbyrdso');
    expect(normaliseForMatch('inspectionbyRDSO')).toBe('inspectionbyrdso');
  });
});

describe('approximateDistance', () => {
  it('is zero for a substring and counts the edits otherwise', () => {
    expect(approximateDistance('inspectionbyrdso', 'rdso')).toBe(0);
    expect(approximateDistance('inspectionbyrds0', 'rdso')).toBe(1);
    expect(approximateDistance('supplyofcable', 'rdso')).toBeGreaterThan(1);
  });
});
