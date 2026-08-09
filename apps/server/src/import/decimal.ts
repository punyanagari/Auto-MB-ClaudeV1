/** Deterministic REAL-float -> decimal-string quantization for the v1
 * importer. SQLite stores quantities and money as IEEE-754 doubles; the
 * target schema stores exact numerics. The rule, applied identically
 * everywhere: take the double's shortest round-trip decimal representation
 * (ECMAScript `String(number)`, which is exact and canonical per spec),
 * then round it AT THE DECIMAL LEVEL to the target scale, half away from
 * zero — the same tie rule PostgreSQL's `numeric` rounding uses. No
 * floating-point arithmetic participates in the rounding itself. */

export interface Quantized {
  /** Exact decimal string at the requested scale, e.g. '50735921.29'. */
  readonly text: string;
  /** True when quantization moved the value by more than 1e-9 relative. */
  readonly changed: boolean;
  /** |quantized - original| / max(|original|, 1e-12). */
  readonly relativeDelta: number;
}

/** Expands ECMAScript number formatting ('1e-7', '1.2e+21') into plain
 * positional decimal notation. */
export function plainDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`not a finite number: ${String(value)}`);
  }
  const raw = String(value);
  if (!raw.includes('e') && !raw.includes('E')) return raw;

  // eslint-disable-next-line security/detect-unsafe-regex -- anchored with one optional non-nested group; linear on all inputs
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw);
  if (!match) throw new RangeError(`unparseable number literal: ${raw}`);
  const sign = match[1] ?? '';
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  const exponent = Number(match[4]);

  const digits = whole + frac;
  const pointIndex = whole.length + exponent;
  if (pointIndex <= 0) {
    return `${sign}0.${'0'.repeat(-pointIndex)}${digits}`;
  }
  if (pointIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(pointIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}

/** Rounds a plain decimal string to `scale` fraction digits, half away
 * from zero, using digit-string arithmetic only. */
export function roundDecimalString(plain: string, scale: number): string {
  const negative = plain.startsWith('-');
  const unsigned = negative ? plain.slice(1) : plain;
  const [wholeRaw = '0', fracRaw = ''] = unsigned.split('.');
  const frac = fracRaw.padEnd(scale + 1, '0');
  const kept = frac.slice(0, scale);
  const nextDigit = frac.charCodeAt(scale) - 48;

  let digits = wholeRaw + kept;
  if (nextDigit >= 5) {
    // Half away from zero: 5 or more in the first dropped digit rounds up.
    digits = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
  }
  const wholeOut = digits.slice(0, digits.length - scale) || '0';
  const fracOut = scale > 0 ? digits.slice(digits.length - scale) : '';
  const magnitude = scale > 0 ? `${wholeOut}.${fracOut}` : wholeOut;
  const isZero = /^0*\.?0*$/.test(magnitude.replace('.', ''));
  return `${negative && !isZero ? '-' : ''}${magnitude}`;
}

export function quantize(value: number, scale: number): Quantized {
  const text = roundDecimalString(plainDecimalString(value), scale);
  const back = Number(text);
  const delta = Math.abs(back - value);
  const relativeDelta = delta / Math.max(Math.abs(value), 1e-12);
  return { text, changed: relativeDelta > 1e-9, relativeDelta };
}
