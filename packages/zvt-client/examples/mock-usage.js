// Hardware-free example: run the built-in mock terminal and pay against it.
//
//   node examples/mock-usage.js
//
import { MockTerminal, ZvtClient } from '@accurateitsolutionorg/nexi-zvt-client';

const mock = new MockTerminal({ scenario: 'approve' });
await mock.start();
console.log('Mock terminal listening on 127.0.0.1:20007');

const client = new ZvtClient({ host: '127.0.0.1', port: 20007, password: '000000' });
client.on('log', (line) => console.log(line));
client.on('status', (s) => console.log('>> status:', s.text));
client.on('printLine', (line) => console.log('|| receipt:', line));

await client.connect();
const registerTrace = await client.register();
console.log(`Registered. (${registerTrace.length} frames exchanged)`);
console.log('Starting EUR 1.00 payment...');

const result = await client.payment(100);
console.log(result.approved ? 'APPROVED' : 'DECLINED', result.resultText);

// Every request sent to the terminal and every response received during this
// payment, for troubleshooting - useful to log or attach to a support ticket.
console.log(`\nFull request/response trace for this payment (${result.trace.length} frames):`);
for (const frame of result.trace) {
  console.log(`  ${frame.timestamp}  ${frame.direction === 'sent' ? 'ECR -> PT' : 'PT -> ECR'}  ${frame.hex}`);
}

client.disconnect();
await mock.stop();
