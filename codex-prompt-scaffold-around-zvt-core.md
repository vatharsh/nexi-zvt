# Codex Prompt: Build the ZVT PoC around existing protocol modules

Copy everything below the line into Codex, run from the repository root.

---

## Mission

This repository already contains a working, type-checked ZVT protocol core (details below). Your job is to scaffold everything around it: an Electron + Angular desktop app, a typed IPC bridge, a mock terminal for hardware-free development, unit tests, and npm scripts — so that a user can enter an amount, press Pay, and complete a card payment on a **Nexi Germany / CCV Fly A77** terminal reachable at `<terminal-ip>:20007` over ZVT/TCP.

## What already exists in the repo — DO NOT REWRITE

These files are tested and are the source of truth for all protocol logic. You may **move** them into a better folder (adjusting imports), and you may **extend** them (e.g. add a BMP tag to the table in `bmp.ts`, add an error code to `constants.ts`), but you must not reimplement, duplicate, or "improve" their logic. If you believe one has a bug, add a failing unit test demonstrating it and fix minimally.

```
zvt/bcd.ts         BCD helpers
zvt/apdu.ts        APDU framing + streaming assembler + ACK/NACK
zvt/constants.ts   Command codes, config-byte flags, error/status text maps
zvt/bmp.ts         Parser for 04 0F Status Information (+ BER-TLV)
zvt/ZvtClient.ts   High-level client (TCP socket, promise-based commands)
example.ts         Offline self-tests + live smoke test (keep as scripts/smoke.ts)
tsconfig.json      Strict TS config (merge into your final tsconfig setup)
```

### Public API you must build against

`zvt/ZvtClient.ts` exports `ZvtClient extends EventEmitter`:

```ts
new ZvtClient({ host, port?, password?, configByte?, connectTimeoutMs?, ackTimeoutMs?, transactionTimeoutMs? })
connect(): Promise<void>
disconnect(): void
register(): Promise<void>                        // ZVT Registration 06 00
payment(amountCents: number): Promise<PaymentResult>   // Authorization 06 01
reversal(receiptNo: number): Promise<PaymentResult>    // 06 30
endOfDay(): Promise<PaymentResult>                     // 06 50
abort(): Promise<void>                                 // 06 B0
// events:
'log'          (line: string)                    // full hex trace, timestamped
'status'       ({ code: number; text: string })  // intermediate status 04 FF
'printLine'    (line: string)                    // receipt lines 06 D1
'disconnected' ()
```

`PaymentResult` includes: `approved`, `resultCode?`, `resultText?`, `amountCents?`, `traceNo?`, `receiptNo?`, `date?`, `time?`, `maskedPan?`, `cardTypeName?`, `terminalId?`, `aid?`, `merchantReceipt: string[]`, `rawStatusInformation?` (hex string), and `unparsedRemainder?` (Buffer of unknown BMPs, for debugging).

`zvt/apdu.ts` exports `buildApdu(ctrl, data)`, `buildAck()`, `buildNack(code)`, `isAck`, `isNack`, `toHex`, and `class ApduAssembler { push(chunk): Apdu[] }` — use these in the mock terminal too, never hand-roll frames.

`zvt/constants.ts` exports `CMD` (all command codes), `CONFIG` (registration config-byte flags), `DEFAULT_CONFIG_BYTE`, `CURRENCY_EUR`, `errorText()`, `intermediateStatusText()`.

## Target project structure

Reorganize into:

```
package.json
tsconfig.base.json
electron/
  main.ts               # BrowserWindow, app lifecycle, loads Angular build/dev URL
  preload.ts            # contextBridge: typed window.zvt API (see IPC contract)
  ipc.ts                # ipcMain handlers wrapping a singleton ZvtClient
  settings.ts           # load/save JSON config in app.getPath('userData')
  zvt/                  # <— MOVE the existing zvt/*.ts here unchanged
mock/
  MockTerminal.ts       # fake ZVT terminal TCP server (see below)
  run-mock.ts           # CLI entry: node/tsx run-mock.ts [--decline|--timeout]
scripts/
  smoke.ts              # the existing example.ts, imports fixed
src/                    # Angular 17+ standalone app
  app/
    settings/           # host, port, password; Connect & Register button; terminal info
    pay/                # amount input (EUR, cents-safe), Pay + Cancel buttons
    status/             # live feed of intermediate status events
    result/             # approved/declined banner, txn fields, receipt text, Reverse button
    log/                # scrolling raw hex trace (both directions), copy-to-clipboard
tests/
  bcd.spec.ts apdu.spec.ts bmp.spec.ts mock-e2e.spec.ts
```

## Electron requirements

- Electron latest LTS. `contextIsolation: true`, `nodeIntegration: false`, no remote module. All ZVT code runs in the **main process only**; the renderer gets a typed API via `preload.ts`.
- Exactly **one** `ZvtClient` instance lives in `ipc.ts`. Serialize commands: if a payment is in progress, reject new `startPayment` calls with a clear error (the client already throws 'Another ZVT command is in progress' — surface it).
- Forward the client's `log`, `status`, `printLine`, `disconnected` events to the renderer via `webContents.send`.
- Write the hex log to a rotating file in userData as well (simple: one file per day, `zvt-YYYY-MM-DD.log`).

### IPC contract (implement exactly, with shared types in a `shared/` folder)

```ts
window.zvt = {
  getConfig(): Promise<ZvtSettings>,
  setConfig(cfg: ZvtSettings): Promise<void>,           // {host, port, password}
  connectAndRegister(): Promise<{ ok: true } | { ok: false; error: string }>,
  startPayment(amountCents: number): Promise<PaymentResultDto>,
  cancelPayment(): Promise<void>,                       // calls abort()
  reversal(receiptNo: number): Promise<PaymentResultDto>,
  endOfDay(): Promise<PaymentResultDto>,
  onStatus(cb): Unsubscribe, onLog(cb): Unsubscribe,
  onPrintLine(cb): Unsubscribe, onDisconnected(cb): Unsubscribe,
}
```

`PaymentResultDto` = `PaymentResult` with Buffers removed/hex-encoded (IPC-safe plain JSON).

## Angular requirements

- Angular 17+ standalone components, signals for state. No NgModules.
- Amount input must be cents-safe: parse "12,34" / "12.34" / "1234" (plain cents when no separator is a footgun — accept only comma/dot decimal with exactly 2 decimals, or whole euros) → integer cents. Never use floating point for money anywhere.
- Pay screen: disable Pay while busy; show a prominent live status line driven by `onStatus`; Cancel button calls `cancelPayment()`.
- Result screen: green approved / red declined banner with `resultText`, all transaction fields in a definition list, monospace receipt text block, "Reverse this payment" (uses `receiptNo`), "Copy raw 04 0F hex" button.
- Settings screen: host/port/password, Save, "Connect & register" test with success (show terminal ID from result if present) or error message. Persist via IPC, not localStorage.
- Keep styling minimal and clean; no UI library needed.

## Mock terminal (must-have)

`mock/MockTerminal.ts`: a `net.Server` on `127.0.0.1:20007` built ONLY with `buildApdu`/`ApduAssembler` from the existing modules:

- On Registration `06 00`: reply ACK `80 00 00`, then Completion `06 0F`.
- On Authorization `06 01`: ACK; after 300 ms send intermediate status `04 FF` code `0x0A` (insert card); after 800 ms `04 FF` code `0x04` (contacting host); after 1500 ms a Status Information `04 0F` echoing the requested amount with BMPs `27=00`, `04=<amount>`, `0B=<incrementing trace>`, `87=<incrementing receipt>`, `8A=05`, `22=<masked PAN nibbles>`; then two `06 D1` print lines; then Completion `06 0F`. Wait for the ECR's ACK after each message before sending the next.
- On Reversal `06 30` and End-of-day `06 50`: ACK → `04 0F` (result 00) → `06 0F`.
- Flags: `--decline` → send `04 0F` with `27=0x6C` then Abort `06 1E` with `0x6C`; `--timeout` → ACK the command and then go silent.
- The mock is also the fixture generator: capture the exact byte sequences it produces into `tests/fixtures/*.hex`.

## Tests & scripts

- vitest. Unit tests for bcd (round-trips, overflow errors), apdu (extended length, assembler with pathological chunking incl. 1-byte-at-a-time), bmp (parse the mock's 04 0F fixture; verify `unparsedRemainder` behavior with an unknown tag).
- `mock-e2e.spec.ts`: start MockTerminal in-process, run `ZvtClient.register()` + `payment(100)`, assert `approved === true`, `amountCents === 100`, receipt lines length 2. Also test the decline path.
- npm scripts: `dev` (Angular dev server + Electron with reload), `mock`, `smoke` (runs scripts/smoke.ts against a real IP: `npm run smoke -- 192.168.x.x`), `test`, `build`, `dist` (electron-builder, Windows + Linux targets).
- CI-friendly: `npm test` must pass headless with no hardware.

## README

Short and practical: prerequisites, how to run against the mock, how to run against a real A77 (find terminal IP in Android WiFi settings; port 20007; ZVT password from Nexi, try 000000; use €0.01 test payments), the troubleshooting trio (network reachability, wrong password → registration NACK, unknown BMPs → check `unparsedRemainder` in the log), and a table of implemented ZVT commands.

## Working order

1. Move `zvt/` into `electron/zvt/`, set up workspace tooling (package.json, tsconfigs, vitest, Angular CLI, Electron), get `npm test` running with the existing self-test logic converted into `tests/*.spec.ts`.
2. MockTerminal + mock-e2e test green.
3. Electron main + preload + IPC + settings persistence.
4. Angular screens wired to `window.zvt`, dev script running end-to-end against the mock.
5. Decline/timeout/cancel paths, log file rotation, README, `dist` build.

Definition of done: `npm run mock` in one shell, `npm run dev` in another → enter 1,00 → Pay → live statuses appear → approved result with receipt text → Reverse succeeds → `npm test` green.
