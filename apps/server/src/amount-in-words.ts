/**
 * Indian-system amount-in-words rendering for the Measurement Book
 * document (spec §5.9 "MB document (PDF)": "total payable this MB,
 * amount in words"). Pure and exact: the input is a numeric(18,2)
 * decimal STRING straight from PostgreSQL, parsed digit-by-digit — no
 * JavaScript float ever touches the value (AGENTS.md money rule).
 *
 * 'Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred
 * Seventy-Eight and Paise Ninety Only'; zero paise omit the paise
 * clause; zero rupees with zero paise render 'Rupees Zero Only'.
 */

const ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const;

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const;

/** 0 <= n < 100 as words ('Seven', 'Nineteen', 'Forty-Five'). */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.trunc(n / 10)] ?? '';
  const unit = n % 10;
  return unit === 0 ? tens : `${tens}-${ONES[unit] ?? ''}`;
}

/** 0 <= n < 1000 as words ('Six Hundred Seventy-Eight'). */
function threeDigits(n: number): string {
  const hundreds = Math.trunc(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return twoDigits(n);
  if (rest === 0) return `${ONES[hundreds] ?? ''} Hundred`;
  return `${ONES[hundreds] ?? ''} Hundred ${twoDigits(rest)}`;
}

/**
 * A non-negative integer (as BigInt, so numeric(18,2)'s 16 integer
 * digits stay exact) in the Indian grouping: ...crore, lakh, thousand,
 * hundred, tens. The crore part recurses, so 'One Hundred Twenty-Three
 * Crore' and beyond render correctly.
 */
function integerWords(n: bigint): string {
  if (n === 0n) return 'Zero';
  const parts: string[] = [];
  const crore = n / 10_000_000n;
  let rest = Number(n % 10_000_000n);
  if (crore > 0n) parts.push(`${integerWords(crore)} Crore`);
  const lakh = Math.trunc(rest / 100_000);
  rest %= 100_000;
  if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);
  const thousand = Math.trunc(rest / 1000);
  rest %= 1000;
  if (thousand > 0) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest > 0) parts.push(threeDigits(rest));
  return parts.join(' ');
}

// eslint-disable-next-line security/detect-unsafe-regex -- fully anchored, one digit run then an optional bounded fraction group with no nested quantifier; linear on all inputs (same shape as mb-remark.ts)
const AMOUNT_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Renders a non-negative numeric(18,2) decimal string ('12345678.90',
 * '0.00', '1000') as Indian-system words. Throws on anything that is
 * not a plain non-negative decimal with at most two fraction digits —
 * the input is a snapshotted SQL total, so a malformed value is a
 * caller bug, never data to be guessed at.
 */
export function amountInWords(amount: string): string {
  const match = AMOUNT_RE.exec(amount.trim());
  if (match === null) {
    throw new Error(`Not a numeric(18,2) decimal string: ${JSON.stringify(amount)}`);
  }
  const rupees = BigInt(match[1] ?? '0');
  const paise = Number((match[2] ?? '').padEnd(2, '0') || '0');
  const rupeeClause = `Rupees ${integerWords(rupees)}`;
  if (paise === 0) return `${rupeeClause} Only`;
  return `${rupeeClause} and Paise ${twoDigits(paise)} Only`;
}
