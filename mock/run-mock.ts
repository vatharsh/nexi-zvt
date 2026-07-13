import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { MockTerminal, type MockScenario } from '@accurateitsolutionorg/nexi-zvt-client';

const scenarios: MockScenario[] = ['approve', 'decline', 'decline-expired', 'timeout', 'slow', 'drop'];

function readScenario(): MockScenario {
  const flag = process.argv.find((arg) => arg.startsWith('--') && scenarios.includes(arg.slice(2) as MockScenario));
  return flag ? (flag.slice(2) as MockScenario) : 'approve';
}

const terminal = new MockTerminal({ scenario: readScenario() });
terminal.on('log', (line) => console.log(line));
await terminal.start();
console.log(`Mock ZVT terminal listening on 127.0.0.1:20007 (${terminal.getStatus().scenario})`);
console.log(`Type one of: ${scenarios.join(', ')}; or "status", "quit".`);

const rl = createInterface({ input, output });
for await (const line of rl) {
  const cmd = line.trim();
  if (cmd === 'quit' || cmd === 'exit') break;
  if (cmd === 'status') {
    console.log(JSON.stringify(terminal.getStatus()));
    continue;
  }
  if (scenarios.includes(cmd as MockScenario)) {
    terminal.setScenario(cmd as MockScenario);
    console.log(`scenario=${cmd}`);
  } else {
    console.log(`unknown command: ${cmd}`);
  }
}

await terminal.stop();
