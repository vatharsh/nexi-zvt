// Registers and runs a EUR 0.01 test payment against a real terminal.
//
//   node examples/real-terminal.js <terminal-ip> [password]
//
import { ZvtClient } from '@accurateitsolutionorg/nexi-zvt-client';

const host = process.argv[2];
const password = process.argv[3] ?? '000000';
if (!host) {
  console.error('Usage: node examples/real-terminal.js <terminal-ip> [password]');
  process.exit(1);
}

const client = new ZvtClient({ host, port: 20007, password });
client.on('log', (line) => console.log(line));
client.on('status', (s) => console.log('>> status:', s.text));
client.on('printLine', (line) => console.log('|| receipt:', line));

await client.connect();
await client.register();
console.log('Registered. Starting EUR 0.01 payment - present a test card...');

const result = await client.payment(1);
console.log(JSON.stringify(result, null, 2));

client.disconnect();
