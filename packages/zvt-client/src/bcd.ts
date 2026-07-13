/**
 * BCD (binary-coded decimal) helpers for the ZVT protocol.
 * ZVT encodes amounts, trace numbers, dates, times, passwords etc. as
 * packed BCD: two decimal digits per byte, most significant digit first.
 */

/** Encode a non-negative integer as packed BCD, left-padded with zeros. */
export function numberToBcd(value: number, byteLength: number): Buffer {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`BCD value must be a non-negative integer, got ${value}`);
  }
  const digits = value.toString();
  const maxDigits = byteLength * 2;
  if (digits.length > maxDigits) {
    throw new RangeError(`Value ${value} does not fit in ${byteLength} BCD bytes`);
  }
  return digitStringToBcd(digits.padStart(maxDigits, '0'));
}

/** Encode a string of decimal digits ("000000", "0978") as packed BCD. */
export function digitStringToBcd(digits: string): Buffer {
  if (!/^\d*$/.test(digits)) {
    throw new RangeError(`BCD input must contain only digits, got "${digits}"`);
  }
  const padded = digits.length % 2 === 0 ? digits : '0' + digits;
  const out = Buffer.alloc(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = padded.charCodeAt(i * 2) - 0x30;
    const lo = padded.charCodeAt(i * 2 + 1) - 0x30;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Decode packed BCD to its digit string ("001234"). Throws on non-BCD nibbles. */
export function bcdToDigitString(buf: Buffer): string {
  let s = '';
  for (const byte of buf) {
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    if (hi > 9 || lo > 9) {
      throw new RangeError(`Invalid BCD byte 0x${byte.toString(16).padStart(2, '0')}`);
    }
    s += hi.toString() + lo.toString();
  }
  return s;
}

/** Decode packed BCD to a number. */
export function bcdToNumber(buf: Buffer): number {
  const s = bcdToDigitString(buf);
  return s.length === 0 ? 0 : parseInt(s, 10);
}

/**
 * Encode an amount in euro-cents as the 6-byte BCD amount field (BMP 04).
 * Example: 1234 (=> EUR 12.34) -> <00 00 00 00 12 34>.
 * Max: 999_999_999_999 cents.
 */
export function amountToBcd(amountCents: number): Buffer {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RangeError(`Amount must be a positive integer of cents, got ${amountCents}`);
  }
  return numberToBcd(amountCents, 6);
}

/** Decode the 6-byte BCD amount field back to cents. */
export function bcdToAmountCents(buf: Buffer): number {
  if (buf.length !== 6) {
    throw new RangeError(`Amount field must be 6 bytes, got ${buf.length}`);
  }
  return bcdToNumber(buf);
}

/** Format cents for display: 1234 -> "12,34" (German convention). */
export function formatCents(amountCents: number): string {
  const euros = Math.floor(amountCents / 100);
  const cents = (amountCents % 100).toString().padStart(2, '0');
  return `${euros},${cents}`;
}
