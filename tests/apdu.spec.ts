import { describe, expect, it } from 'vitest';
import { ApduAssembler, buildAck, buildApdu, buildNack, isAck, isNack, toHex } from '@accurateitsolutionorg/nexi-zvt-client';

describe('APDU framing', () => {
  it('builds small and extended-length frames', () => {
    expect(toHex(buildApdu(0x0601, Buffer.from([0x04])))).toBe('06 01 01 04');
    const big = buildApdu(0x06d3, Buffer.alloc(300, 0xaa));
    expect(toHex(big.subarray(0, 5))).toBe('06 D3 FF 2C 01');
    expect(big.length).toBe(305);
  });

  it('identifies ACK and NACK frames', () => {
    const ack = new ApduAssembler().push(buildAck())[0];
    const nack = new ApduAssembler().push(buildNack(0x9a))[0];
    expect(isAck(ack)).toBe(true);
    expect(isNack(nack)).toBe(true);
  });

  it('assembles pathological one-byte-at-a-time chunks', () => {
    const frames = [
      buildApdu(0x04ff, Buffer.from([0x0a])),
      buildApdu(0x060f),
      buildApdu(0x06d3, Buffer.alloc(260, 0x55)),
    ];
    const asm = new ApduAssembler();
    const out = [];
    for (const byte of Buffer.concat(frames)) {
      out.push(...asm.push(Buffer.from([byte])));
    }
    expect(out.map((a) => a.ctrl)).toEqual([0x04ff, 0x060f, 0x06d3]);
    expect(out[2].data.length).toBe(260);
  });
});
