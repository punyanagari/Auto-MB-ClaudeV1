import { describe, expect, it } from 'vitest';
import {
  TallyMasterImportError,
  proposeContact,
  readPlCode,
  readTallyMasters,
} from '../src/tally-masters.js';

/**
 * Reading a TallyPrime `All Masters` export (migration 0118).
 *
 * EVERY MASTER IN THIS FILE IS INVENTED. The export this reader was built
 * against is a real company's chart of accounts and no ledger name, GSTIN
 * or group of it may enter the repository. What is reproduced here is its
 * SHAPE — UTF-16LE with a byte-order mark and no XML declaration, one tag
 * per line, ~150 `Yes`/`No` engine flags per master, illegal `&#4;`
 * character references, GSTINs in a nested registration block, work codes
 * spelled three different ways — with values that belong to nobody.
 *
 * The reader is a pure function of some bytes, so everything below runs
 * without a database, an organisation or a session. What it becomes on
 * the wire is `tally-masters.integration.test.ts`.
 */

/** The export's own encoding: UTF-16LE with a BOM and no XML declaration,
 * which is the thing that makes the file unopenable by ordinary means and
 * therefore the thing every fixture must reproduce. */
function utf16(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

interface LedgerSpec {
  readonly name: string;
  readonly parent: string;
  readonly guid?: string;
  readonly alterId?: string;
  readonly gstin?: string;
  readonly nestedGstin?: string;
  readonly openingBalance?: string;
  readonly extra?: string;
  /** Omit the ALTERID tag entirely — a master Tally exported without
   * an edit counter. */
  readonly noAlterId?: boolean;
}

let guidCounter = 0;

function ledger(spec: LedgerSpec): string {
  guidCounter += 1;
  const guid =
    spec.guid ??
    `00000000-0000-4000-8000-000000000000-${String(guidCounter).padStart(8, '0')}`;
  return [
    `     <LEDGER NAME="${spec.name}" RESERVEDNAME="">`,
    // The engine noise a real master carries, in miniature: booleans the
    // reader must drop, a self-closing tag with an attribute that must
    // not disturb its depth count, and a nested list.
    '      <OLDAUDITENTRYIDS.LIST TYPE="Number">',
    '       <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>',
    '      </OLDAUDITENTRYIDS.LIST>',
    '      <LANGUAGENAME.LIST TYPE="String"/>',
    `      <GUID>${guid}</GUID>`,
    `      <PARENT>${spec.parent}</PARENT>`,
    ...(spec.noAlterId === true
      ? []
      : [`      <ALTERID> ${spec.alterId ?? '4321'}</ALTERID>`]),
    '      <ISBILLWISEON>Yes</ISBILLWISEON>',
    '      <ISDELETED>No</ISDELETED>',
    '      <AFFECTSSTOCK>No</AFFECTSSTOCK>',
    ...(spec.gstin === undefined
      ? []
      : [`      <PARTYGSTIN>${spec.gstin}</PARTYGSTIN>`]),
    ...(spec.openingBalance === undefined
      ? []
      : [`      <OPENINGBALANCE>${spec.openingBalance}</OPENINGBALANCE>`]),
    ...(spec.nestedGstin === undefined
      ? []
      : [
          '      <LEDGSTREGDETAILS.LIST>',
          `       <GSTIN>${spec.nestedGstin}</GSTIN>`,
          '       <APPLICABLEFROM>20230401</APPLICABLEFROM>',
          '      </LEDGSTREGDETAILS.LIST>',
        ]),
    ...(spec.extra === undefined ? [] : [spec.extra]),
    '      <DAILYSTDRATES.LIST>      </DAILYSTDRATES.LIST>',
    '     </LEDGER>',
  ].join('\r\n');
}

function group(name: string, parent: string): string {
  guidCounter += 1;
  return [
    `     <GROUP NAME="${name}" RESERVEDNAME="">`,
    `      <GUID>g-${String(guidCounter)}</GUID>`,
    `      <PARENT>${parent}</PARENT>`,
    '      <ISSUBLEDGER>No</ISSUBLEDGER>',
    '     </GROUP>',
  ].join('\r\n');
}

function envelope(...masters: string[]): Buffer {
  return utf16(
    [
      '<ENVELOPE>',
      ' <HEADER>',
      '  <TALLYREQUEST>Import Data</TALLYREQUEST>',
      ' </HEADER>',
      ' <BODY>',
      '  <IMPORTDATA>',
      '   <REQUESTDATA>',
      ...masters.map((master) =>
        ['    <TALLYMESSAGE xmlns:UDF="TallyUDF">', master, '    </TALLYMESSAGE>'].join(
          '\r\n',
        ),
      ),
      '   </REQUESTDATA>',
      '  </IMPORTDATA>',
      ' </BODY>',
      '</ENVELOPE>',
    ].join('\r\n'),
  );
}

/** The group tree every fixture stands on: Tally's two reserved party
 * roots, each with a layer of this-company-shaped subdivision under it,
 * plus a deposits branch that belongs to neither. */
const TREE = [
  group('Sundry Debtors', 'Current Assets'),
  group('Fixture Divisions', 'Sundry Debtors'),
  group('Sundry Creditors', 'Current Liabilities'),
  group('Creditors for Z- Fixture Purchases', 'Sundry Creditors'),
  group('Deposits (Asset)', 'Current Assets'),
  group('Fixture Security Deposits', 'Deposits (Asset)'),
  group('Duties & Taxes', 'Current Liabilities'),
];

describe('reading the export', () => {
  it('reads a UTF-16LE export with no XML declaration', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name: 'Fixture Division One', parent: 'Fixture Divisions' }),
      ),
    );
    expect(read.refusals).toEqual([]);
    expect(read.groupCount).toBe(TREE.length);
    expect(read.ledgers).toHaveLength(1);
    const [first] = read.ledgers;
    expect(first?.name).toBe('Fixture Division One');
    expect(first?.alterId).toBe(4321);
    expect(first?.guid).toMatch(/^00000000-/);
    expect(first?.isDeleted).toBe(false);
  });

  it('reads a UTF-8 export too, because that is what re-saving one produces', () => {
    const utf16Buffer = envelope(
      ...TREE,
      ledger({ name: 'Fixture Division One', parent: 'Fixture Divisions' }),
    );
    const asUtf8 = Buffer.from(utf16Buffer.subarray(2).toString('utf16le'), 'utf8');
    expect(readTallyMasters(asUtf8).ledgers).toHaveLength(1);
  });

  /* THE WHOLE REASON THIS IS A LINE SCANNER. `&#4;` is illegal in XML 1.0
     and expat refuses the entire document over one of them, which is why
     no ordinary parser can open the real export at all. */
  it('reads through the illegal character references that stop every XML parser', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name: 'Fixture&#4; Division', parent: 'Fixture Divisions' }),
      ),
    );
    expect(read.refusals).toEqual([]);
    expect(read.ledgers[0]?.name).toBe('Fixture Division');
  });

  it('decodes the named entities and drops nothing else', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({
          name: 'Rails &amp; Signals &lt;Pvt&gt;',
          parent: 'Fixture Divisions',
        }),
      ),
    );
    expect(read.ledgers[0]?.name).toBe('Rails & Signals <Pvt>');
  });

  it('keeps the meaningful fields and drops the Yes/No engine flags', () => {
    const read = readTallyMasters(
      envelope(...TREE, ledger({ name: 'Fixture One', parent: 'Fixture Divisions' })),
    );
    const fields = read.ledgers[0]?.sourceFields ?? {};
    expect(Object.keys(fields)).toContain('GUID');
    expect(Object.keys(fields)).toContain('PARENT');
    expect(Object.keys(fields)).not.toContain('ISBILLWISEON');
    expect(Object.keys(fields)).not.toContain('AFFECTSSTOCK');
    expect(Object.keys(fields)).not.toContain('DAILYSTDRATES.LIST');
  });

  it('refuses a file that is not a Tally envelope', () => {
    expect(() =>
      readTallyMasters(utf16('<html><body>not tally</body></html>')),
    ).toThrow(TallyMasterImportError);
  });

  it('refuses a file with no line breaks rather than assembling it', () => {
    const oneLine = `<ENVELOPE>${'<PADDING>x</PADDING>'.repeat(20_000)}`;
    expect(() => readTallyMasters(utf16(oneLine))).toThrow(TallyMasterImportError);
  });

  it('names the line of a ledger it will not store, and imports the rest', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name: 'Fixture One', parent: 'Fixture Divisions' }),
        // No GUID: the idempotency key is missing, so the master cannot be
        // re-imported safely and is not imported at all.
        [
          '     <LEDGER NAME="Fixture Nameless" RESERVEDNAME="">',
          '      <PARENT>Fixture Divisions</PARENT>',
          '     </LEDGER>',
        ].join('\r\n'),
        ledger({ name: 'Fixture Two', parent: 'Fixture Divisions' }),
      ),
    );
    expect(read.ledgers.map((entry) => entry.name)).toEqual([
      'Fixture One',
      'Fixture Two',
    ]);
    expect(read.refusals).toHaveLength(1);
    expect(read.refusals[0]?.ledgerName).toBe('Fixture Nameless');
    expect(read.refusals[0]?.lineNumber).toBeGreaterThan(1);
    expect(read.refusals[0]?.reason).toMatch(/GUID/);
  });

  it('imports the first of two masters sharing a GUID and names the second', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name: 'Fixture One', parent: 'Fixture Divisions', guid: 'same-guid' }),
        ledger({ name: 'Fixture Two', parent: 'Fixture Divisions', guid: 'same-guid' }),
      ),
    );
    expect(read.ledgers.map((entry) => entry.name)).toEqual(['Fixture One']);
    expect(read.refusals[0]?.reason).toMatch(/same GUID/);
  });
});

describe('classifying by Tally’s own reserved groups', () => {
  const read = () =>
    readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name: 'Fixture Division One', parent: 'Fixture Divisions' }),
        ledger({ name: 'Fixture Direct Debtor', parent: 'Sundry Debtors' }),
        ledger({
          name: 'Fixture Supplier',
          parent: 'Creditors for Z- Fixture Purchases',
        }),
        ledger({ name: 'SD Fixture PL-77', parent: 'Fixture Security Deposits' }),
        ledger({ name: 'CGST Fixture 9%', parent: 'Duties & Taxes' }),
      ),
    );

  it('reads ancestry, not the immediate group', () => {
    const byName = new Map(read().ledgers.map((entry) => [entry.name, entry]));
    // Two levels below Sundry Debtors, and the immediate group name says
    // nothing about what it is.
    expect(byName.get('Fixture Division One')?.classification).toBe('customer');
    expect(byName.get('Fixture Division One')?.groupPath).toEqual([
      'Current Assets',
      'Sundry Debtors',
      'Fixture Divisions',
    ]);
    expect(byName.get('Fixture Direct Debtor')?.classification).toBe('customer');
    expect(byName.get('Fixture Supplier')?.classification).toBe('vendor');
  });

  it('calls a work-coded ledger outside the party tree an instrument', () => {
    const byName = new Map(read().ledgers.map((entry) => [entry.name, entry]));
    expect(byName.get('SD Fixture PL-77')?.classification).toBe('instrument');
    expect(byName.get('SD Fixture PL-77')?.plCode).toBe('PL-77');
  });

  it('calls everything else other', () => {
    const byName = new Map(read().ledgers.map((entry) => [entry.name, entry]));
    expect(byName.get('CGST Fixture 9%')?.classification).toBe('other');
    expect(byName.get('CGST Fixture 9%')?.plCode).toBeNull();
  });

  it('leaves a ledger whose group is absent from the export unrooted', () => {
    const read = readTallyMasters(
      envelope(ledger({ name: 'Fixture Orphan', parent: 'A Group Nobody Exported' })),
    );
    expect(read.ledgers[0]?.groupPath).toEqual(['A Group Nobody Exported']);
    expect(read.ledgers[0]?.classification).toBe('other');
  });

  it('survives a cyclic group tree rather than looping on it', () => {
    const read = readTallyMasters(
      envelope(
        group('Loop A', 'Loop B'),
        group('Loop B', 'Loop A'),
        ledger({ name: 'Fixture Looped', parent: 'Loop A' }),
      ),
    );
    expect(read.ledgers[0]?.groupPath).toEqual(['Loop B', 'Loop A']);
  });
});

describe('the work code in a ledger name', () => {
  it('reads the spellings the census found, including the underscored one', () => {
    expect(readPlCode('SD Fixture PL-282').code).toBe('PL-282');
    expect(readPlCode('SD Fixture PL 282').code).toBe('PL-282');
    expect(readPlCode('123456_BG_Fixture_PL.282').code).toBe('PL-282');
    // The bank-guarantee shape, where the code is welded to the division
    // by an underscore and `\b` would never have fired.
    expect(readPlCode('123456_BG_Fixture_PL282').code).toBe('PL-282');
    expect(readPlCode('123456.Sr.Dfm.Fixture.P.B.G. Pl.282').code).toBe('PL-282');
  });

  /* A boundary that admitted a letter would read a work code out of an
     ordinary English word, and one that admitted a digit would key an
     instrument to the wrong contract by truncating the number. */
  it('is not fooled by a word ending in PL, or by a longer number', () => {
    expect(readPlCode('SUPPL 22 Fixture').code).toBeNull();
    expect(readPlCode('APL-9 Fixture').code).toBeNull();
    expect(readPlCode('Fixture PL-28210').code).toBeNull();
  });

  it('strips leading zeros so one work has one code', () => {
    expect(readPlCode('FDR No.99 PL-07').code).toBe('PL-7');
  });

  it('reads one code written twice as one code', () => {
    expect(readPlCode('SD Fixture PL-77 renewal of PL-77')).toEqual({
      code: 'PL-77',
      ambiguous: false,
    });
  });

  /* OWNER RULING 6: ambiguity proposes nothing. A ledger naming two works
     is stored with no code rather than with a coin flip between them. */
  it('proposes nothing when a name carries two different codes', () => {
    expect(readPlCode('SD Fixture PL-77 and PL-78')).toEqual({
      code: null,
      ambiguous: true,
    });
  });

  it('finds no code in a name that has none', () => {
    expect(readPlCode('Fixture Supplies Private Limited').code).toBeNull();
    expect(readPlCode('PLANT AND MACHINERY 2024').code).toBeNull();
  });

  it('counts the ambiguous ones on the read', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({
          name: 'SD Fixture PL-77 and PL-78',
          parent: 'Fixture Security Deposits',
        }),
      ),
    );
    expect(read.ambiguousCodeCount).toBe(1);
    expect(read.ledgers[0]?.plCode).toBeNull();
    // No code, outside the party tree: not an instrument this wave can
    // key to anything, so it is `other` and it is visible as such.
    expect(read.ledgers[0]?.classification).toBe('other');
  });
});

describe('the GSTIN', () => {
  it('prefers the master’s own PARTYGSTIN', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({
          name: 'Fixture One',
          parent: 'Fixture Divisions',
          gstin: '27AAACR1234A1ZP',
          nestedGstin: '29AAACR1234A1ZQ',
        }),
      ),
    );
    expect(read.ledgers[0]?.gstin).toBe('27AAACR1234A1ZP');
  });

  /* 1,373 real ledgers carry a GSTIN only in the nested registration
     block against 1,047 in the direct tag, so reading only the direct one
     would leave a quarter of the identifiable parties matching by name. */
  it('falls back to the nested registration block', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({
          name: 'Fixture One',
          parent: 'Fixture Divisions',
          nestedGstin: '29AAACR1234A1ZQ',
        }),
      ),
    );
    expect(read.ledgers[0]?.gstin).toBe('29AAACR1234A1ZQ');
  });

  it('nulls and counts one that is not a GSTIN, rather than refusing the ledger', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({
          name: 'Fixture One',
          parent: 'Fixture Divisions',
          gstin: 'NOT-A-GSTIN',
        }),
      ),
    );
    expect(read.ledgers).toHaveLength(1);
    expect(read.ledgers[0]?.gstin).toBeNull();
    expect(read.malformedGstinCount).toBe(1);
  });

  it('reads an opening balance and nulls one it cannot store', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({
          name: 'Fixture One',
          parent: 'Fixture Divisions',
          openingBalance: '-125000.50',
        }),
        ledger({
          name: 'Fixture Two',
          parent: 'Fixture Divisions',
          openingBalance: 'not a number',
        }),
      ),
    );
    expect(read.ledgers[0]?.openingBalance).toBe('-125000.50');
    expect(read.ledgers[1]?.openingBalance).toBeNull();
  });
});

describe('two masters that clean to the same name', () => {
  /* The real export holds such a pair: they differ only by an illegal
     `&#4;`, which every text CHECK in this schema refuses. Both are real
     masters with their own GUIDs and both belong in the census. */
  const read = () =>
    readTallyMasters(
      envelope(
        ...TREE,
        ledger({
          name: 'Fixture&#4; Twin',
          parent: 'Fixture Divisions',
          gstin: '27AAACR1234A1ZP',
        }),
        ledger({ name: 'Fixture Twin', parent: 'Fixture Divisions' }),
      ),
    );

  it('imports both and marks them ambiguous', () => {
    const result = read();
    expect(result.ledgers).toHaveLength(2);
    expect(result.duplicateNameCount).toBe(2);
    expect(result.ledgers.every((entry) => entry.nameAmbiguous)).toBe(true);
    expect(result.refusals).toEqual([]);
  });

  it('still proposes on GSTIN, which is the better identifier anyway', () => {
    const [withGstin, withoutGstin] = read().ledgers;
    const candidates = [
      { id: 'contact-1', name: 'Fixture Twin', gstin: '27AAACR1234A1ZP' },
    ];
    expect(proposeContact(withGstin!, candidates)).toEqual({
      contactId: 'contact-1',
      method: 'gstin',
    });
    // The other one's only evidence is the shared name, which is evidence
    // about neither of them.
    expect(proposeContact(withoutGstin!, candidates)).toBeNull();
  });
});

describe('proposing a contact', () => {
  const candidates = [
    { id: 'contact-gst', name: 'Some Other Spelling Ltd', gstin: '27AAACR1234A1ZP' },
    { id: 'contact-name', name: 'Fixture Supplies Private Limited', gstin: null },
    { id: 'contact-twin-a', name: 'Twinned Name Ltd', gstin: '29AAACR1234A1ZQ' },
    { id: 'contact-twin-b', name: 'Twinned Name Ltd', gstin: null },
  ];
  const one = (name: string, parent: string, gstin?: string) => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name, parent, ...(gstin === undefined ? {} : { gstin }) }),
      ),
    );
    return read.ledgers[0]!;
  };

  /* OWNER RULING 8: GSTIN first, then exact name. */
  it('matches on GSTIN even when the names disagree completely', () => {
    expect(
      one('Fixture Division One', 'Fixture Divisions', '27AAACR1234A1ZP'),
    ).toBeDefined();
    expect(
      proposeContact(
        one('Fixture Division One', 'Fixture Divisions', '27AAACR1234A1ZP'),
        candidates,
      ),
    ).toEqual({ contactId: 'contact-gst', method: 'gstin' });
  });

  it('falls back to an exact name', () => {
    expect(
      proposeContact(
        one('Fixture Supplies Private Limited', 'Creditors for Z- Fixture Purchases'),
        candidates,
      ),
    ).toEqual({ contactId: 'contact-name', method: 'name' });
  });

  it('proposes nothing when two contacts answer to the same name', () => {
    expect(
      proposeContact(one('Twinned Name Ltd', 'Fixture Divisions'), candidates),
    ).toBeNull();
  });

  it('proposes nothing for a near miss', () => {
    expect(
      proposeContact(one('Fixture Supplies Pvt Ltd', 'Fixture Divisions'), candidates),
    ).toBeNull();
  });

  /* An SD ledger's name is a railway division's name with a work code on
     it. Proposing the division as the contact is exactly the confident
     wrong answer ruling 6 refuses. */
  it('never proposes a contact for an instrument or an expense head', () => {
    expect(
      proposeContact(
        one('Fixture Supplies Private Limited PL-77', 'Fixture Security Deposits'),
        candidates,
      ),
    ).toBeNull();
    expect(
      proposeContact(
        one('Fixture Supplies Private Limited', 'Duties & Taxes'),
        candidates,
      ),
    ).toBeNull();
  });
});

/* --- the review findings --------------------------------------------------- */

describe('a master with no edit counter', () => {
  /* FINDING 2a. Zero is a real ALTERID — a master Tally has never altered
     — so reading "absent" as zero made the two indistinguishable and
     armed 0118's regression guard against the honest case. */
  it('reads as unknown, not as zero', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name: 'Fixture One', parent: 'Fixture Divisions', noAlterId: true }),
        ledger({ name: 'Fixture Two', parent: 'Fixture Divisions', alterId: '0' }),
      ),
    );
    expect(read.refusals).toEqual([]);
    // Absent.
    expect(read.ledgers[0]?.alterId).toBeNull();
    // Present, and genuinely zero.
    expect(read.ledgers[1]?.alterId).toBe(0);
  });
});

describe('a truncated export', () => {
  /* FINDING 4. A file that stops mid-master is a half-written export, and
     the ledgers before the cut are a complete-looking prefix. Importing
     them would record a fraction of the chart of accounts with every
     count agreeing with itself and being wrong. */
  const complete = envelope(
    ...TREE,
    ledger({ name: 'Fixture One', parent: 'Fixture Divisions' }),
    ledger({ name: 'Fixture Two', parent: 'Fixture Divisions' }),
  );

  it('refuses a file cut in the middle of a master', () => {
    const text = complete.subarray(2).toString('utf16le');
    const cut = text.slice(0, text.indexOf('Fixture Two') + 40);
    let thrown: unknown;
    try {
      readTallyMasters(utf16(cut));
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(TallyMasterImportError);
    expect((thrown as TallyMasterImportError).code).toBe('TALLY_EXPORT_TRUNCATED');
    // The byte position, so an operator can see WHERE it stops.
    expect((thrown as TallyMasterImportError).message).toMatch(/\d+ bytes/);
  });

  it('refuses a file with no closing envelope even between masters', () => {
    const text = complete.subarray(2).toString('utf16le');
    const cut = text.slice(0, text.indexOf('</ENVELOPE>'));
    expect(() => readTallyMasters(utf16(cut))).toThrow(TallyMasterImportError);
  });

  it('accepts the complete file it was cut from', () => {
    expect(readTallyMasters(complete).ledgers).toHaveLength(2);
  });
});

describe('a value that spans lines', () => {
  /* FINDING 5. Tally writes one tag per line, but a NARRATION an operator
     typed a newline into is written across several — and any line of that
     text which happens to look like a tag was counted as an element
     opening, leaving the scanner one level too deep for the rest of the
     master and dropping every direct field after it. */
  const spanning = ledger({
    name: 'Fixture One',
    parent: 'Fixture Divisions',
    gstin: '27AAACR1234A1ZP',
    extra: [
      '      <BILLALLOCATIONS.LIST>',
      '       <NAME>Opening</NAME>',
      // The narration an operator typed newlines into. The middle line is
      // what does the damage: on its own it is exactly the shape of a tag
      // OPENING, so it was counted as one and never closed — leaving the
      // scanner one level deep for the rest of the master, and every
      // direct field after this list read as nested and dropped.
      '       <NARRATION>Paid against the running account bill',
      '<AMOUNT>',
      '       and a second continuation line</NARRATION>',
      '      </BILLALLOCATIONS.LIST>',
    ].join('\r\n'),
  });

  it('does not let the text bleed into the master’s own fields', () => {
    const read = readTallyMasters(envelope(...TREE, spanning));
    expect(read.refusals).toEqual([]);
    const [entry] = read.ledgers;
    // The fields BEFORE the spanning value.
    expect(entry?.name).toBe('Fixture One');
    expect(entry?.guid).not.toBe('');
    // …and the ones AFTER it, which are what a depth desync eats. The
    // GSTIN and the trailing DAILYSTDRATES.LIST both sit past the
    // narration in the fixture.
    expect(entry?.gstin).toBe('27AAACR1234A1ZP');
    expect(entry?.classification).toBe('customer');
    // The narration's own text is not mistaken for a field.
    expect(Object.keys(entry?.sourceFields ?? {})).not.toContain('AMOUNT');
  });

  it('still finds the master that follows it', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        spanning,
        ledger({ name: 'Fixture Two', parent: 'Fixture Divisions' }),
      ),
    );
    expect(read.ledgers.map((entry) => entry.name)).toEqual([
      'Fixture One',
      'Fixture Two',
    ]);
  });
});

describe('the column bounds, proven at parse rather than by a CHECK', () => {
  /* FINDING 8. Each of these has a CHECK behind it in 0118, and a CHECK is
     the wrong place to meet one: it arrives mid-commit as a 23514 naming a
     constraint, with nothing saying which master or where. */
  it('refuses a GUID longer than the census stores, naming the ledger', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({
          name: 'Fixture Long Guid',
          parent: 'Fixture Divisions',
          guid: 'g'.repeat(81),
        }),
        ledger({ name: 'Fixture One', parent: 'Fixture Divisions' }),
      ),
    );
    expect(read.ledgers.map((entry) => entry.name)).toEqual(['Fixture One']);
    expect(read.refusals[0]?.ledgerName).toBe('Fixture Long Guid');
    expect(read.refusals[0]?.reason).toMatch(/GUID/);
    expect(read.refusals[0]?.lineNumber).toBeGreaterThan(1);
  });

  it('refuses a group name longer than the census stores', () => {
    const read = readTallyMasters(
      envelope(...TREE, ledger({ name: 'Fixture One', parent: 'G'.repeat(301) })),
    );
    expect(read.ledgers).toEqual([]);
    expect(read.refusals[0]?.reason).toMatch(/group name/);
  });

  it('refuses a group ancestry deeper than the census stores', () => {
    // Twenty-two groups in a chain, so the ledger at the bottom resolves
    // past the array bound 0118 declares.
    const deep = Array.from({ length: 22 }, (_, index) =>
      group(`Deep ${String(index)}`, index === 0 ? '' : `Deep ${String(index - 1)}`),
    );
    const read = readTallyMasters(
      envelope(...deep, ledger({ name: 'Fixture Deep', parent: 'Deep 21' })),
    );
    expect(read.ledgers).toEqual([]);
    expect(read.refusals[0]?.ledgerName).toBe('Fixture Deep');
    expect(read.refusals[0]?.reason).toMatch(/groups deep/);
  });
});

describe('names that differ only by whitespace', () => {
  /* FINDING 9. The ambiguity verdict has to be reached under the SAME
     normalisation the contact match compares under. Keyed on a bare
     toLowerCase(), `Acme  Ltd` and `Acme Ltd` counted as two names,
     neither was marked ambiguous, and both then matched the same
     contact — straight through the hole the guard exists to close. */
  const read = () =>
    readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name: 'Fixture  Twin  Ltd', parent: 'Fixture Divisions' }),
        ledger({ name: 'Fixture Twin Ltd', parent: 'Fixture Divisions' }),
      ),
    );

  it('marks both ambiguous', () => {
    const result = read();
    expect(result.ledgers).toHaveLength(2);
    expect(result.duplicateNameCount).toBe(2);
    expect(result.ledgers.every((entry) => entry.nameAmbiguous)).toBe(true);
  });

  it('proposes neither to the contact they both collapse onto', () => {
    const candidates = [{ id: 'contact-1', name: 'Fixture Twin Ltd', gstin: null }];
    for (const entry of read().ledgers) {
      expect(proposeContact(entry, candidates)).toBeNull();
    }
  });
});

describe('a four-digit run that is a year, not a work code', () => {
  /* FINDING 10. Scanned against the real export there is not one
     four-digit code in the file — every real one is 1..282 — so a space
     before four digits can only be a year. A hyphen still admits one,
     because that is the spelling works.work_code itself uses. */
  it('does not read a year after a space as a work code', () => {
    expect(readPlCode('SD Fixture Division PL 2024').code).toBeNull();
    expect(readPlCode('SD Fixture Division PL.2024').code).toBeNull();
    expect(readPlCode('SD Fixture Division PL2024').code).toBeNull();
  });

  it('still admits a hyphenated four-digit code', () => {
    expect(readPlCode('SD Fixture PL-1000').code).toBe('PL-1000');
  });

  it('admits the dot-space spelling the census lists', () => {
    expect(readPlCode('123456.Sr.Dfm.Fixture.P.B.G. Pl. 282').code).toBe('PL-282');
  });

  it('keeps every separator the real export uses', () => {
    // The four shapes the scan counted: hyphen, dot, bare space, none.
    expect(readPlCode('SD Fixture PL-282').code).toBe('PL-282');
    expect(readPlCode('SD Fixture PL.282').code).toBe('PL-282');
    expect(readPlCode('SD Fixture PL 282').code).toBe('PL-282');
    expect(readPlCode('123456_BG_Fixture_PL282').code).toBe('PL-282');
  });

  it('classifies a year-named ledger as other rather than as an instrument', () => {
    const read = readTallyMasters(
      envelope(
        ...TREE,
        ledger({ name: 'SD Fixture PL 2024', parent: 'Fixture Security Deposits' }),
      ),
    );
    expect(read.ledgers[0]?.plCode).toBeNull();
    expect(read.ledgers[0]?.classification).toBe('other');
  });
});
