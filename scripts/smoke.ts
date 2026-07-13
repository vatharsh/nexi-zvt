/**
 * Usage example (Electron main process or plain Node):
 *
 *   npx tsx example.ts 192.168.1.50
 *
 * Runs registration and a EUR 0.01 test payment against the terminal.
 * Without an IP argument it runs offline self-tests of the framing and
 * parsing code instead.
 */

import * as assert from 'node:assert';
import {
  ApduAssembler,
  buildApdu,
  toHex,
  amountToBcd,
  bcdToAmountCents,
  numberToBcd,
  bcdToNumber,
  parseStatusInformation,
  ZvtClient,
} from '@accurateitsolutionorg/nexi-zvt-client';

function selfTest(): void {
  // BCD round-trips
  assert.strictEqual(toHex(amountToBcd(1234)), '00 00 00 00 12 34');
  assert.strictEqual(bcdToAmountCents(amountToBcd(999_99)), 99_999);
  assert.strictEqual(bcdToNumber(numberToBcd(69111155 % 10000, 2)), 1155);

  // APDU framing incl. extended length
  const small = buildApdu(0x0601, Buffer.from([0x04, 0, 0, 0, 0, 0x12, 0x34]));
  assert.strictEqual(toHex(small.subarray(0, 3)), '06 01 07');
  const big = buildApdu(0x06d3, Buffer.alloc(300, 0xaa));
  assert.strictEqual(toHex(big.subarray(0, 5)), '06 D3 FF 2C 01'); // 300 = 0x012C LE

  // Streaming assembler: two frames split across three chunks
  const asm = new ApduAssembler();
  const f1 = buildApdu(0x04ff, Buffer.from([0x0a]));
  const f2 = buildApdu(0x060f);
  const all = Buffer.concat([f1, f2]);
  const out = [
    ...asm.push(all.subarray(0, 2)),
    ...asm.push(all.subarray(2, 5)),
    ...asm.push(all.subarray(5)),
  ];
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].ctrl, 0x04ff);
  assert.strictEqual(out[1].ctrl, 0x060f);

  // Status information parsing: 27=00, 04=amount 1.00, 0B=trace 42, 87=receipt 7, 8A=girocard
  const statusPayload = Buffer.from([
    0x27, 0x00,
    0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x0b, 0x00, 0x00, 0x42,
    0x87, 0x00, 0x07,
    0x8a, 0x05,
  ]);
  const info = parseStatusInformation(statusPayload);
  assert.strictEqual(info.approved, true);
  assert.strictEqual(info.amountCents, 100);
  assert.strictEqual(info.traceNo, 42);
  assert.strictEqual(info.receiptNo, 7);
  assert.strictEqual(info.cardTypeName, 'girocard');

  console.log('All self-tests passed.');
}

async function live(host: string): Promise<void> {
  const client = new ZvtClient({ host, port: 20007, password: '000000' });
  client.on('log', (l) => console.log(l));
  client.on('status', (s) => console.log(`>> TERMINAL: ${s.text}`));
  client.on('printLine', (l) => console.log(`|| ${l}`));

  await client.connect();
  await client.register();
  console.log('Registered. Starting EUR 0.01 payment — present a test card...');
  const result = await client.payment(1);
  console.log(JSON.stringify(result, null, 2));
  client.disconnect();
}

const host = process.argv[2];
if (host) {
  live(host).catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
} else {
  selfTest();
}
