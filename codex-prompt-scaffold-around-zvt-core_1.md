# Codex Prompt: Build the ZVT PoC around existing protocol modules

Copy everything below the line into Codex, run from the repository root.

---

## Mission

This repository already contains a working, type-checked ZVT protocol core (details below). Your job is to scaffold everything around it: an Electron + Angular desktop app, a typed IPC bridge, a mock terminal for hardware-free development, unit tests, and npm scripts — so that a user can enter an amount, press Pay, and complete a card payment on a **Nexi Germany / CCV Fly A77** terminal reachable at `<terminal-ip>:20007` over ZVT/TCP.

**IMPORTANT CONSTRAINT: no physical terminal is available during development.** The entire application — UI, IPC, payment flow, all error paths — must be built and demonstrably working against the mock terminal alone. Treat the mock as the primary target and the real terminal as a future configuration change (a different IP in settings). Nothing in the app may special-case the mock: the app must speak identical bytes to `127.0.0.1:20007` and to a real A77, so switching to hardware later is purely a settings change, zero code change.

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
  // configuration & mode
  getConfig(): Promise<ZvtSettings>,        // { mode: 'mock'|'real', real: {host, port, password} }
  setConfig(cfg: ZvtSettings): Promise<void>,
  setMode(mode: 'mock' | 'real'): Promise<void>,  // starts/stops embedded mock, rewires client profile

  // transactions — identical behavior in both modes
  connectAndRegister(): Promise<{ ok: true } | { ok: false; error: string }>,
  startPayment(amountCents: number): Promise<PaymentResultDto>,
  cancelPayment(): Promise<void>,                       // calls abort()
  reversal(receiptNo: number): Promise<PaymentResultDto>,
  endOfDay(): Promise<PaymentResultDto>,

  // mock control — the ONLY mock-specific surface; rejects when mode === 'real'
  mockSetScenario(s: 'approve'|'decline'|'decline-expired'|'timeout'|'slow'|'drop'): Promise<void>,
  mockGetStatus(): Promise<{ running: boolean; scenario: string; connections: number }>,

  // events
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
- Settings screen: two named connection profiles managed side by side — **Mock terminal** (fixed `127.0.0.1:20007`, password `000000`, not editable) and **Real terminal** (host/port/password entered by the user, persisted). "Connect & register" test button works in both modes and shows success (with terminal ID if present) or the error message.

### Terminal mode switch (Mock / Real) — core UX requirement

- A prominent, always-visible mode toggle in the app header: `Mock` / `Real terminal`, with the active profile's host:port shown next to it. Mock mode additionally shows a colored "MOCK" badge on every screen (including the result screen) so a mock payment can never be mistaken for a real one.
- **Mock mode**: the Electron main process starts the MockTerminal in-process when this mode is activated (and stops it on switch-away/app quit). The UI shows a **mock control panel** (only in this mode): scenario picker (approve / decline / decline-expired / timeout / slow / drop) applied live via IPC, plus mock status (listening / connection count).
- **Real mode**: mock server is stopped; the client connects to the configured real-terminal profile. No scenario panel.
- **One code path rule**: mode switching only selects which profile (host/port/password) is handed to the single `ZvtClient` and whether the embedded mock server runs. The payment/reversal/end-of-day/IPC/UI code must be byte-for-byte identical in both modes — no `if (mock)` anywhere in the transaction path. The only mock-aware code allowed is: mock server lifecycle, the scenario panel, and the MOCK badge.
- Transaction history shown in the Result/Log area must be tagged with the mode it ran in (mock vs real), so results from the two are never conflated when the hardware arrives.
- Keep styling minimal and clean; no UI library needed.

## Mock terminal (must-have)

`mock/MockTerminal.ts`: a `net.Server` on `127.0.0.1:20007` built ONLY with `buildApdu`/`ApduAssembler` from the existing modules. It must be a reusable class with `start()`, `stop()`, `setScenario()`, and a status getter, usable in two ways: **embedded** (imported and managed by the Electron main process when the app is in Mock mode — the primary usage) and **standalone** (`run-mock.ts` CLI for tests/CI). Scenario switching in the app goes through the `mockSetScenario` IPC method; the standalone CLI also accepts a scenario flag and stdin commands.

- On Registration `06 00`: reply ACK `80 00 00`, then Completion `06 0F`.
- On Authorization `06 01`: ACK; after 300 ms send intermediate status `04 FF` code `0x0A` (insert card); after 800 ms `04 FF` code `0x04` (contacting host); after 1500 ms a Status Information `04 0F` echoing the requested amount with BMPs `27=00`, `04=<amount>`, `0B=<incrementing trace>`, `87=<incrementing receipt>`, `8A=05`, `22=<masked PAN nibbles>`; then two `06 D1` print lines; then Completion `06 0F`. Wait for the ECR's ACK after each message before sending the next.
- On Reversal `06 30` and End-of-day `06 50`: ACK → `04 0F` (result 00) → `06 0F`.
- Scenarios (all switchable live, without restarting the mock or dropping its listener):
  - `approve` (default) — happy path as above
  - `decline` — send `04 0F` with `27=0x6C` then Abort `06 1E` with `0x6C`
  - `decline-expired` — same but code `0x78` (card expired)
  - `timeout` — ACK the command, then go silent (exercises the client's transaction timeout)
  - `slow` — happy path with 5–8 s host delay and extra `04 FF` "Please wait" statuses (exercises the live status UI)
  - `drop` — close the TCP connection mid-transaction (exercises reconnect + error surfacing in UI)
- **Realism requirement — chunked writes**: the mock must NOT write each frame in a single `socket.write`. Randomly split every outbound frame into 1–3 chunks with small delays, and occasionally coalesce a frame with the next one. This continuously stress-tests `ApduAssembler` exactly the way a real network does.
- The mock is also the fixture generator: capture the exact byte sequences it produces into `tests/fixtures/*.hex`.

## Tests & scripts

- vitest. Unit tests for bcd (round-trips, overflow errors), apdu (extended length, assembler with pathological chunking incl. 1-byte-at-a-time), bmp (parse the mock's 04 0F fixture; verify `unparsedRemainder` behavior with an unknown tag).
- `mock-e2e.spec.ts`: start MockTerminal in-process and cover EVERY scenario: `approve` (assert `approved === true`, `amountCents === 100`, 2 receipt lines, incrementing receipt/trace numbers across two payments), `decline` and `decline-expired` (assert `approved === false` with the right `resultCode`/`resultText`), `timeout` (assert the client rejects with its timeout error), `drop` (assert a clean rejection, and that a subsequent connect + payment succeeds again — no stuck `busy` state), plus reversal and end-of-day. These tests are the substitute for hardware — they must be thorough.
- npm scripts: `dev` (Angular dev server + Electron with reload — the app starts in Mock mode by default, so this alone is the full developer loop), `mock` (standalone mock for tests/CI), `smoke` (runs scripts/smoke.ts against a real IP: `npm run smoke -- 192.168.x.x`), `test`, `build`, `dist` (electron-builder, Windows + Linux targets).
- CI-friendly: `npm test` must pass headless with no hardware.

## README

Short and practical: prerequisites, how to run (`npm run dev` — starts in Mock mode), how to use the mock control panel and scenarios, how to switch to Real mode, and a dedicated **"When the real terminal arrives" checklist** section:

1. Put the POS machine and the A77 on the same network; find the terminal's IP in its Android WiFi settings; verify reachability (`nc -vz <ip> 20007` or Test-NetConnection on Windows).
2. `npm run smoke -- <terminal-ip>` — registration + €0.01 payment from the CLI with full hex trace, before touching the UI.
3. If registration fails: ZVT password is probably not `000000` — get the ECR password from Nexi.
4. If a payment result looks incomplete: check the log for `unparsedRemainder` — that hex identifies unknown BMP tags to add to the table in `bmp.ts` (a two-line change).
5. In the app: enter the terminal's IP in the Real terminal profile, flip the mode switch to Real, Connect & register, then run a €0.01 payment + reversal + end-of-day through the exact same UI you've been using against the mock.

Also include the troubleshooting trio (network reachability, wrong password → registration NACK, unknown BMPs → `unparsedRemainder`) and a table of implemented ZVT commands.

## Working order

1. Move `zvt/` into `electron/zvt/`, set up workspace tooling (package.json, tsconfigs, vitest, Angular CLI, Electron), get `npm test` running with the existing self-test logic converted into `tests/*.spec.ts`.
2. MockTerminal class (embeddable + standalone) with all scenarios + chunked writes; full mock-e2e suite green. This is the foundation — do not proceed until it is solid.
3. Electron main + preload + IPC + settings persistence + mode switching with embedded mock lifecycle.
4. Angular screens wired to `window.zvt`; mode toggle, MOCK badge, and mock control panel working; `npm run dev` running end-to-end in Mock mode.
5. Exercise every mock scenario manually through the UI (decline, timeout, drop, slow, cancel-during-payment), plus switching Mock → Real → Mock (Real will fail to connect without hardware — verify it fails cleanly with a clear message and switching back to Mock recovers fully); log file rotation; README; `dist` build.

Definition of done — all verified WITHOUT hardware: `npm run dev` → app opens in Mock mode with MOCK badge → enter 1,00 → Pay → live statuses stream → approved result with receipt text → Reverse succeeds → switch scenario to `decline`, `timeout`, `drop`, `slow` from the mock control panel and confirm the UI handles each gracefully (clear error message, app never stuck, next payment works) → flip to Real mode with an unreachable IP and confirm a clean connection error, then flip back to Mock and pay again successfully → `npm test` green. When these pass, the only remaining unknowns are hardware-specific and are covered by the README checklist above.
