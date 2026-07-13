import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStatusInformation, toHex } from '@accurateitsolutionorg/nexi-zvt-client';

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.replace(/\s+/g, ''), 'hex');
}

describe('BMP status parser', () => {
  it('parses the mock status fixture', () => {
    const fixture = readFileSync('tests/fixtures/mock-status.hex', 'utf8');
    const info = parseStatusInformation(hexToBuffer(fixture));
    expect(info.approved).toBe(true);
    expect(info.resultCode).toBe(0);
    expect(info.amountCents).toBe(100);
    expect(info.traceNo).toBe(41);
    expect(info.receiptNo).toBe(7);
    expect(info.cardTypeName).toBe('girocard');
    expect(info.maskedPan).toBe('5413****');
    expect(info.terminalId).toBe('12345678');
  });

  it('keeps unknown BMPs as unparsed remainder', () => {
    const payload = Buffer.concat([hexToBuffer('27 00'), Buffer.from([0xfe, 0x01, 0x02])]);
    const info = parseStatusInformation(payload);
    expect(info.approved).toBe(true);
    expect(info.unparsedRemainder).toBeDefined();
    expect(toHex(info.unparsedRemainder!)).toBe('FE 01 02');
  });
});
