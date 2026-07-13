# Nexi A77 ZVT PoC

Electron + Angular desktop proof of concept for ZVT/TCP payments against a Nexi Germany / CCV Fly A77 terminal. Development is hardware-free by default: the app starts in Mock mode and speaks the same ZVT bytes to `127.0.0.1:20007` that it will later send to a real terminal.

## Prerequisites

- Node.js LTS is recommended. The current workstation uses Node 23, which works with the classic Angular browser builder but still prints Angular's odd-version warning.
- npm

## Run

```bash
npm install
npm run dev
```

The app opens in Mock mode. Enter `1,00`, press Pay, watch live status messages, then reverse the approved result from the Result screen.

Useful scripts:

```bash
npm test
npm run build
npm run mock
npm run smoke -- 192.168.x.x
npm run dist
```

## Mock Mode

Mock mode starts an embedded ZVT terminal on `127.0.0.1:20007` with password `000000`. The mock control panel can switch scenarios live:

| Scenario | Behavior |
| --- | --- |
| `approve` | Registration and payment success with receipt lines |
| `decline` | Result code `6C`, terminal abort |
| `decline-expired` | Result code `78`, terminal abort |
| `timeout` | ACKs the command, then goes silent |
| `slow` | Extra status messages and a longer host delay |
| `drop` | Closes the TCP connection mid-transaction |

## Real Mode

Open Settings, enter the A77 IP, port `20007`, and the ZVT password. Flip the header switch to Real terminal, then use Connect & register before sending a payment. The payment, reversal, end-of-day, log, and result paths are identical between Mock and Real mode.

## When The Real Terminal Arrives

1. Put the POS machine and the A77 on the same network; find the terminal IP in Android WiFi settings; verify reachability with `nc -vz <ip> 20007` or `Test-NetConnection <ip> -Port 20007` on Windows.
2. Run `npm run smoke -- <terminal-ip>` for registration and a EUR 0.01 payment from the CLI with full hex trace.
3. If registration fails, the ZVT password is probably not `000000`; get the ECR password from Nexi.
4. If a payment result looks incomplete, check the log for `unparsedRemainder`; that hex identifies unknown BMP tags to add in `electron/zvt/bmp.ts`.
5. In the app, enter the terminal IP in the Real terminal profile, switch to Real, Connect & register, then run a EUR 0.01 payment, reversal, and end-of-day through the same UI used against the mock.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Cannot connect | Network reachability to `<ip>:20007` |
| Registration rejected | Wrong ZVT/ECR password |
| Missing result fields | `unparsedRemainder` in the hex log, then add the BMP tag parser |
| App stuck after failure | Switch back to Mock and run an approve payment; the mock e2e suite covers timeout and drop recovery |

Logs are written to Electron `userData` as `zvt-YYYY-MM-DD.log`.

## Implemented ZVT Commands

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
