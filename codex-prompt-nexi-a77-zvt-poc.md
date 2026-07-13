# Codex Prompt: ZVT Payment Terminal PoC (Electron + Angular)

Copy everything below the line into Codex.

---

## Mission

Scaffold a standalone proof-of-concept desktop app called `zvt-poc` that communicates with a **Nexi Germany (Concardis) CCV Fly A77** payment terminal over the **ZVT protocol (ZVT 700 / T3C)** via **TCP/IP**. The PoC must be able to run a card payment end-to-end: send an amount to the terminal, track live status, receive the result and receipt data, and display everything in the UI.

This is a PoC that will later be merged into a production POS built with Electron + Angular, so keep the ZVT logic cleanly isolated in its own module with a small, typed public API.

## Hard facts about the target terminal (do not invent alternatives)

- Device: CCV Fly A77 (PAX A77 hardware), Android-based, payment app "SECpos EVO", cash-register app "app2pay".
- Integration protocol: **ZVT over TCP/IP**. The terminal is the **TCP server**; the POS (ECR) is the **TCP client**.
- Terminal listens on **port 20007** (unencrypted ZVT, confirmed enabled on the device). TLS variant exists on port 20009 but is disabled; do NOT implement TLS for this PoC — just make host/port configurable.
- The terminal has **no printer**. Receipt text/data returned over ZVT must be captured by the POS.
- Currency: EUR. Country: Germany. Amounts in ZVT are **BCD-encoded, in cents, 6 bytes** (e.g. €12.34 → `00 00 00 00 12 34` as BCD digits 000000001234).
- The terminal and the POS PC are on the same LAN/WLAN. Terminal IP is entered by the user in the app settings.
- Standard ZVT ECR password is 6 BCD digits, commonly `000000` (make it configurable).

## Authoritative references

1. Official ZVT specification (English, free PDF): "PA00P015 – ZVT Interface, ECR ↔ PT protocol" and "PA00P016" from https://www.terminalhersteller.de/downloads.aspx — implement message framing and commands per this spec.
2. Reference open-source implementation to port logic from (C#, MIT): https://github.com/Portalum/Portalum.Zvt — its `ZvtClient`, APDU framing, BMP parsing and TCP handling are a correct model. Port the relevant logic to TypeScript; do not add a .NET dependency.
3. Do NOT use Nexi's e-commerce/cloud APIs (Nexi Checkout, XPay, PayEngine, SmartPOS Cloud API). They are irrelevant here — this terminal is driven locally via ZVT.

## Tech stack & project layout

- Electron (latest LTS) + Angular (v17+, standalone components) + TypeScript strict mode.
- Node's built-in `net` module for the TCP socket. No native modules.
- Monorepo-ish single package is fine. Suggested layout:

```
zvt-poc/
  package.json
  electron/
    main.ts                 # app bootstrap, window, wiring
    preload.ts              # contextBridge exposing typed IPC API
    zvt/
      ZvtClient.ts          # high-level client: registration, payment, reversal, endOfDay
      ZvtConnection.ts      # TCP socket, reconnect, byte stream -> APDU frames
      apdu.ts               # APDU build/parse, length handling (incl. extended length FF LL LL)
      bmp.ts                # BMP/TLV field parsers for 04 0F status information
      bcd.ts                # BCD encode/decode helpers (amounts, numbers, dates)
      constants.ts          # command codes, error codes, intermediate status texts
      types.ts              # PaymentResult, TerminalStatus, ReceiptData, etc.
    mock/
      MockTerminal.ts       # a fake ZVT terminal TCP server for development
  src/ (Angular app)
    app/
      pay/                  # amount input, Pay / Cancel buttons
      status/               # live status feed (intermediate status messages)
      result/               # result panel: approved/declined, txn data, receipt text
      settings/             # terminal IP, port, password; connection test
      log/                  # raw hex trace of every frame sent/received
```

## ZVT protocol requirements (implement exactly)

### Framing
- Every message is an APDU: `CCRC APRC LEN [DATA]` — 2 command bytes, then length. If length ≤ 254 it's 1 byte; if larger, length byte is `FF` followed by 2 little-endian length bytes.
- After receiving any command APDU from the terminal, the ECR must answer with a **positive acknowledge `80 00 00`** (or error `84 XX 00`). Likewise the terminal ACKs our commands with `80 00 00`.
- One command at a time: after sending e.g. Authorization, keep the socket in "transaction in progress" state until Completion/Abort. Queue or reject concurrent requests.

### Commands to implement (ECR → terminal)
- **Registration `06 00`**: payload = password (3 bytes BCD), config byte, currency code CC `09 78` (EUR). Set config-byte bits so that: ECR prints receipts (terminal has no printer), intermediate status messages are sent to ECR, and (for the PoC) manual payments at the terminal remain allowed. Send it once after connecting.
- **Authorization / payment `06 01`**: BMP `04` amount (6-byte BCD). Optional BMP `49` currency. This starts the card payment.
- **Reversal `06 30`**: password + BMP `87` receipt number of the transaction to reverse.
- **End-of-day `06 50`**: password. Triggers Kassenschnitt/day-end closure.
- **Abort `06 B0`**: cancel an ongoing payment from the ECR side.
- (Nice to have, stub is fine) Repeat receipt `06 20`, Status enquiry `05 01`.

### Messages to handle (terminal → ECR)
- **Intermediate status `04 FF`**: 1-byte status code (+ optional TLV with display text). Map the common codes to human-readable strings (e.g. "Insert/present card", "Please enter PIN", "Contacting host", "Remove card") and emit them as events. Unknown codes → show hex.
- **Status information `04 0F`**: the transaction result. Parse at minimum these BMPs: `27` result code (00 = success), `04` amount, `0B` trace number, `0C` time, `0D` date, `87` receipt number, `19` payment type, `22` PAN (masked), `29` terminal ID, `3B` AID, `8A` card type, `2A` VU number, `3C` additional text, and TLV container `06` if present (may contain receipt/cardholder data). Unknown BMPs must be skipped gracefully using the spec's length rules — never crash on unknown fields.
- **Print line `06 D1` and print text block `06 D3`**: collect lines into merchant/customer receipt buffers and expose them on the result. (Depending on config the terminal may deliver receipts via 04 0F TLV instead — support both paths.)
- **Completion `06 0F`** → resolve the payment promise with the collected result. **Abort `06 1E`** → reject with the 1-byte error code, mapped to the spec's error text table (e.g. `6C` = card declined... include the common table from the spec).

### Connection behaviour
- Connect on demand, keep-alive while app is open, auto-reconnect with backoff.
- Configurable timeouts: connect 5 s; payment overall timeout ~90 s (customer interaction takes time); ACK timeout 5 s.
- Full hex logging of every inbound/outbound frame with direction + timestamp, surfaced to the Log view and written to a rotating file.

## Electron/Angular integration contract

- All ZVT code runs in the **main process only**. Renderer gets a typed API via `contextBridge`:

```ts
window.zvt = {
  configure(cfg: { host: string; port: number; password: string }): Promise<void>;
  connectAndRegister(): Promise<TerminalInfo>;
  startPayment(amountCents: number): Promise<PaymentResult>;
  cancelPayment(): Promise<void>;
  reversal(receiptNo: number): Promise<PaymentResult>;
  endOfDay(): Promise<EndOfDayResult>;
  onStatus(cb: (s: { code: number; text: string }) => void): Unsubscribe;
  onLog(cb: (line: string) => void): Unsubscribe;
}
```

- `PaymentResult` must include: `approved: boolean`, `errorCode?`, `errorText?`, `amountCents`, `receiptNo`, `traceNo`, `date`, `time`, `cardType?`, `maskedPan?`, `terminalId?`, `aid?`, `merchantReceipt?: string[]`, `customerReceipt?: string[]`, plus `rawStatusInformation` (hex) for debugging.
- UI flow: Settings → "Test connection" (connect + registration, show terminal ID) → Pay screen (amount in EUR with cents, big Pay button) → live status feed while the customer interacts with the terminal → Result screen with receipt text and a "Reverse this payment" button. Persist config in a JSON file via `electron-store` or plain fs.

## Mock terminal (must-have for development)

Implement `MockTerminal.ts`: a TCP server on 127.0.0.1:20007 that speaks just enough ZVT to test the client without hardware. On Registration it ACKs and completes; on Authorization it ACKs, emits 2–3 intermediate statuses with delays, then a plausible `04 0F` status information (success, amount echoed, incrementing receipt/trace numbers, fake masked PAN), a couple of `06 D1` print lines, then `06 0F` completion. Add an env flag to simulate decline (`04 0F` result ≠ 00 + `06 1E`) and timeout. Provide npm scripts: `npm run mock`, `npm run dev` (Electron + Angular with live reload), `npm run e2e:mock` (an automated script that runs one payment against the mock and asserts the parsed result).

## Testing & acceptance criteria

- Unit tests (vitest or jest) for: BCD encode/decode, APDU build/parse incl. extended length, BMP parsing of a captured real `04 0F` frame (create fixtures), error-code mapping.
- Acceptance (against real terminal, manual): with terminal IP configured, pressing Pay for €0.01 shows the amount on the A77, intermediate statuses stream in the UI, tapping a test card produces an approved result with receipt number and receipt text; Reverse then successfully reverses it; End-of-day runs.
- The code must never crash on unknown/extra bytes from the terminal — log and continue.

## Explicit non-goals

- No TLS/ZVT-secured mode, no O.P.I. protocol, no Nexi cloud APIs, no serial/USB transport, no receipt PDF rendering, no database persistence (the production POS handles that; just expose clean result objects).

Work step by step: (1) scaffold project + build tooling, (2) bcd/apdu/bmp with unit tests, (3) connection + registration, (4) mock terminal, (5) payment flow end-to-end vs mock, (6) reversal + end-of-day + abort, (7) Angular UI polish + hex log view, (8) README with setup instructions and a protocol cheat-sheet table of implemented commands.
