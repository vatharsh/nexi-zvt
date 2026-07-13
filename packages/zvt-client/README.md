# @accurateitsolutionorg/nexi-zvt-client

ZVT protocol client for CCV/Nexi payment terminals (tested against the A77) over TCP, plus a mock terminal for hardware-free development and tests.

## Install

```bash
npm install @accurateitsolutionorg/nexi-zvt-client
```

## Usage

```ts
import { ZvtClient } from '@accurateitsolutionorg/nexi-zvt-client';

const client = new ZvtClient({ host: '192.168.1.50', port: 20007, password: '000000' });
client.on('log', (line) => console.log(line));
client.on('status', (s) => console.log('status:', s.text));
client.on('printLine', (line) => console.log('receipt:', line));

await client.connect();
await client.register();
const result = await client.payment(100); // EUR 1.00
console.log(result.approved, result.resultText);
```

## Mock terminal

```ts
import { MockTerminal } from '@accurateitsolutionorg/nexi-zvt-client';

const mock = new MockTerminal({ scenario: 'approve' });
await mock.start(); // listens on 127.0.0.1:20007
```

Scenarios: `approve`, `decline`, `decline-expired`, `timeout`, `slow`, `drop`.

## Examples

Runnable, end-to-end examples ship in the package under `examples/`:

```bash
# Hardware-free: spins up the mock terminal and pays against it
node examples/mock-usage.js

# Against a real terminal on your network
node examples/real-terminal.js 192.168.1.50
```

## Request/response tracing

Every call to `register()`, `payment()`, `reversal()`, `endOfDay()`, or `abort()` captures the full list of APDUs sent to and received from the terminal for that operation:

```ts
const trace = await client.register(); // FrameTrace[]
const result = await client.payment(100);
console.log(result.trace); // FrameTrace[] — same shape, attached to the result

// After a thrown error (timeout, NACK, connection drop), the trace of the
// operation that failed is still available:
try {
  await client.register();
} catch (e) {
  console.log(client.getLastTrace());
}
```

Each `FrameTrace` is `{ direction: 'sent' | 'received', ctrl: number, ctrlHex: string, hex: string, timestamp: string }` — plain, JSON-serializable data, safe to log or send over IPC.

## What's exported

- `ZvtClient`, `ZvtClientConfig`, `ZvtClientEvents`, `PaymentResult`, `FrameTrace`
- `MockTerminal`, `MockTerminalOptions`, `MockScenario`
- Low-level protocol helpers: `Apdu`, `ApduAssembler`, `buildApdu`, `buildAck`, `buildNack`, `isAck`, `isNack`, `toHex`, `ctrlHex`
- BCD helpers: `amountToBcd`, `bcdToAmountCents`, `digitStringToBcd`, `bcdToDigitString`, `numberToBcd`, `bcdToNumber`
- Status parsing: `parseStatusInformation`, `StatusInformation`
- Constants: `CMD`, `CURRENCY_EUR`, `DEFAULT_CONFIG_BYTE`, `errorText`, `intermediateStatusText`

## Implemented ZVT commands

| Command | Direction | Purpose |
| --- | --- | --- |
| `06 00` | ECR -> PT | Registration |
| `06 01` | ECR -> PT | Authorization/payment |
| `06 30` | ECR -> PT | Reversal by receipt number |
| `06 50` | ECR -> PT | End-of-day |
| `06 B0` | ECR -> PT | Abort/cancel |
| `04 FF` | PT -> ECR | Intermediate status |
| `04 0F` | PT -> ECR | Status information BMPs |
| `06 D1` | PT -> ECR | Receipt print line |
| `06 0F` | PT -> ECR | Completion |
| `06 1E` | PT -> ECR | Terminal abort |
