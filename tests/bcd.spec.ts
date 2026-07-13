import { describe, expect, it } from 'vitest';
import { amountToBcd, bcdToAmountCents, bcdToDigitString, bcdToNumber, digitStringToBcd, numberToBcd, toHex } from '@accurateitsolutionorg/nexi-zvt-client';

describe('BCD helpers', () => {
  it('round-trips amounts and numbers', () => {
    expect(toHex(amountToBcd(1234))).toBe('00 00 00 00 12 34');
    expect(bcdToAmountCents(amountToBcd(99_999))).toBe(99_999);
    expect(bcdToNumber(numberToBcd(1155, 2))).toBe(1155);
    expect(bcdToDigitString(digitStringToBcd('0978'))).toBe('0978');
  });

  it('rejects overflow and invalid digits', () => {
    expect(() => numberToBcd(1_000_000, 3)).toThrow(/does not fit/);
    expect(() => digitStringToBcd('12A4')).toThrow(/only digits/);
    expect(() => amountToBcd(0)).toThrow(/positive/);
    expect(() => bcdToDigitString(Buffer.from([0x1a]))).toThrow(/Invalid BCD/);
  });
});
