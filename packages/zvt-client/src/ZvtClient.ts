/**
 * High-level ZVT client: owns the TCP socket to the terminal, frames/deframes
 * APDUs, ACKs terminal messages, and exposes promise-based commands.
 *
 * Designed to run in the Electron MAIN process only.
 */

import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  ACK_CTRL,
  Apdu,
  ApduAssembler,
  buildAck,
  buildApdu,
  isAck,
  isNack,
  toHex,
  ctrlHex,
} from './apdu.js';
import { amountToBcd, digitStringToBcd, numberToBcd } from './bcd.js';
import {
  CMD,
  CURRENCY_EUR,
  DEFAULT_CONFIG_BYTE,
  errorText,
  intermediateStatusText,
} from './constants.js';
import { parseStatusInformation, StatusInformation } from './bmp.js';

export interface ZvtClientConfig {
  host: string;
  port?: number; // default 20007
  password?: string; // 6 digits, default "000000"
  configByte?: number;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  transactionTimeoutMs?: number;
}

export interface PaymentResult extends StatusInformation {
  merchantReceipt: string[];
  customerReceipt: string[];
  rawStatusInformation?: string;
  /** Every APDU sent to and received from the terminal for this transaction, in order. */
  trace: FrameTrace[];
}

/** One APDU exchanged with the terminal, for troubleshooting. */
export interface FrameTrace {
  direction: 'sent' | 'received';
  ctrl: number;
  ctrlHex: string;
  hex: string;
  timestamp: string;
}

export interface ZvtClientEvents {
  status: (s: { code: number; text: string }) => void;
  log: (line: string) => void;
  printLine: (line: string) => void;
  disconnected: () => void;
}

/** Minimal CP437 -> unicode mapping for German receipt text. */
const CP437: Record<number, string> = {
  0x81: 'ü', 0x84: 'ä', 0x8e: 'Ä', 0x94: 'ö', 0x99: 'Ö', 0x9a: 'Ü',
  0xe1: 'ß', 0xee: '€',
};
function decodeCp437(buf: Buffer): string {
  let s = '';
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : (CP437[b] ?? '?');
  return s;
}

export class ZvtClient extends EventEmitter {
  private socket?: net.Socket;
  private assembler = new ApduAssembler();
  private readonly cfg: Required<ZvtClientConfig>;

  private ackWaiter?: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private completionWaiter?: {
    resolve: (a: Apdu) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  };

  private lastStatusInformation?: StatusInformation;
  private lastStatusInformationRaw?: Buffer;
  private receiptLines: string[] = [];
  private busy = false;
  private trace: FrameTrace[] = [];

  constructor(config: ZvtClientConfig) {
    super();
    this.cfg = {
      host: config.host,
      port: config.port ?? 20007,
      password: config.password ?? '000000',
      configByte: config.configByte ?? DEFAULT_CONFIG_BYTE,
      connectTimeoutMs: config.connectTimeoutMs ?? 5000,
      ackTimeoutMs: config.ackTimeoutMs ?? 5000,
      transactionTimeoutMs: config.transactionTimeoutMs ?? 90_000,
    };
  }

  // ---------------------------------------------------------------- socket

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.cfg.host, port: this.cfg.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connect timeout to ${this.cfg.host}:${this.cfg.port}`));
      }, this.cfg.connectTimeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.socket = socket;
        this.assembler.reset();
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('close', () => {
          this.log('-- connection closed --');
          this.failPending(new Error('Connection closed'));
          this.emit('disconnected');
        });
        socket.on('error', (err) => this.log(`socket error: ${err.message}`));
        this.log(`connected to ${this.cfg.host}:${this.cfg.port}`);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private send(ctrl: number, frame: Buffer): void {
    if (!this.socket || this.socket.destroyed) throw new Error('Not connected');
    this.log(`ECR -> PT  ${toHex(frame)}`);
    this.recordFrame('sent', ctrl, frame);
    this.socket.write(frame);
  }

  private log(line: string): void {
    this.emit('log', `[${new Date().toISOString()}] ${line}`);
  }

  private recordFrame(direction: 'sent' | 'received', ctrl: number, raw: Buffer): void {
    this.trace.push({
      direction,
      ctrl,
      ctrlHex: ctrlHex(ctrl),
      hex: toHex(raw),
      timestamp: new Date().toISOString(),
    });
  }

  /** Every APDU exchanged during the most recent (or still in-flight) command. */
  getLastTrace(): FrameTrace[] {
    return [...this.trace];
  }

  // ------------------------------------------------------------- receiving

  private onData(chunk: Buffer): void {
    let frames: Apdu[];
    try {
      frames = this.assembler.push(chunk);
    } catch (e) {
      this.log(`frame error: ${(e as Error).message}; resetting stream`);
      this.assembler.reset();
      return;
    }
    for (const apdu of frames) this.onApdu(apdu);
  }

  private onApdu(apdu: Apdu): void {
    this.log(`PT -> ECR  ${toHex(apdu.raw)}`);
    this.recordFrame('received', apdu.ctrl, apdu.raw);

    if (isAck(apdu)) {
      this.settleAck();
      return;
    }
    if (isNack(apdu)) {
      const code = apdu.ctrl & 0xff;
      this.settleAck(new Error(`Terminal NACK: ${errorText(code)}`));
      return;
    }

    // Every command from the terminal must be acknowledged by the ECR.
    this.send(ACK_CTRL, buildAck());

    switch (apdu.ctrl) {
      case CMD.INTERMEDIATE_STATUS: {
        const code = apdu.data[0] ?? 0;
        this.emit('status', { code, text: intermediateStatusText(code) });
        break;
      }
      case CMD.STATUS_INFORMATION: {
        this.lastStatusInformationRaw = apdu.data;
        this.lastStatusInformation = parseStatusInformation(apdu.data);
        if (this.lastStatusInformation.unparsedRemainder) {
          this.log(
            `04 0F contained unknown BMPs, remainder: ${toHex(this.lastStatusInformation.unparsedRemainder)}`,
          );
        }
        break;
      }
      case CMD.PRINT_LINE: {
        // data = 1 attribute byte + CP437 text
        const line = decodeCp437(apdu.data.subarray(1));
        this.receiptLines.push(line);
        this.emit('printLine', line);
        break;
      }
      case CMD.PRINT_TEXT_BLOCK: {
        this.log('received 06 D3 print text block (TLV) — stored raw');
        this.receiptLines.push(`[06D3] ${toHex(apdu.data)}`);
        break;
      }
      case CMD.COMPLETION:
      case CMD.ABORT_FROM_PT: {
        this.settleCompletion(apdu);
        break;
      }
      default:
        this.log(`unhandled command ${ctrlHex(apdu.ctrl)} — acknowledged and ignored`);
    }
  }

  // -------------------------------------------------------------- waiting

  private waitForAck(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiter = undefined;
        reject(new Error('Timeout waiting for terminal ACK'));
      }, this.cfg.ackTimeoutMs);
      this.ackWaiter = { resolve, reject, timer };
    });
  }

  private settleAck(err?: Error): void {
    const w = this.ackWaiter;
    if (!w) return;
    this.ackWaiter = undefined;
    clearTimeout(w.timer);
    err ? w.reject(err) : w.resolve();
  }

  private waitForCompletion(timeoutMs: number): Promise<Apdu> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completionWaiter = undefined;
        reject(new Error('Timeout waiting for completion from terminal'));
      }, timeoutMs);
      this.completionWaiter = { resolve, reject, timer };
    });
  }

  private settleCompletion(apdu: Apdu): void {
    const w = this.completionWaiter;
    if (!w) return;
    this.completionWaiter = undefined;
    clearTimeout(w.timer);
    w.resolve(apdu);
  }

  private failPending(err: Error): void {
    this.settleAck(err);
    const w = this.completionWaiter;
    if (w) {
      this.completionWaiter = undefined;
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /** Send a command, await terminal ACK, then await Completion/Abort. */
  private async transact(ctrl: number, data: Buffer, timeoutMs: number): Promise<Apdu> {
    if (this.busy) throw new Error('Another ZVT command is in progress');
    this.busy = true;
    try {
      await this.connect();
      this.lastStatusInformation = undefined;
      this.lastStatusInformationRaw = undefined;
      this.receiptLines = [];
      this.trace = [];
      const completion = this.waitForCompletion(timeoutMs);
      const ack = this.waitForAck();
      this.send(ctrl, buildApdu(ctrl, data));
      await ack;
      return await completion;
    } finally {
      this.busy = false;
    }
  }

  private buildPaymentResult(finalApdu: Apdu): PaymentResult {
    const info: StatusInformation =
      this.lastStatusInformation ?? { approved: false, otherBmps: [] };
    const aborted = finalApdu.ctrl === CMD.ABORT_FROM_PT;
    if (aborted) {
      const code = finalApdu.data[0] ?? 0x6c;
      info.approved = false;
      info.resultCode = info.resultCode ?? code;
      info.resultText = info.resultText ?? errorText(code);
    }
    return {
      ...info,
      merchantReceipt: [...this.receiptLines],
      customerReceipt: [], // split by print attributes if needed
      rawStatusInformation: this.lastStatusInformationRaw
        ? toHex(this.lastStatusInformationRaw)
        : undefined,
      trace: [...this.trace],
    };
  }

  // -------------------------------------------------------------- commands

  /** Registration 06 00 — run once after connecting. Returns the request/response trace. */
  async register(): Promise<FrameTrace[]> {
    const data = Buffer.concat([
      digitStringToBcd(this.cfg.password), // 3 bytes
      Buffer.from([this.cfg.configByte]),
      CURRENCY_EUR,
    ]);
    const completion = await this.transact(CMD.REGISTRATION, data, 15_000);
    if (completion.ctrl === CMD.ABORT_FROM_PT) {
      throw new Error(`Registration aborted: ${errorText(completion.data[0] ?? 0)}`);
    }
    this.log('registration complete');
    return [...this.trace];
  }

  /** Authorization 06 01 — start a card payment. Amount in euro-cents. */
  async payment(amountCents: number): Promise<PaymentResult> {
    const data = Buffer.concat([
      Buffer.from([0x04]),
      amountToBcd(amountCents),
      Buffer.from([0x49]),
      CURRENCY_EUR,
    ]);
    const completion = await this.transact(
      CMD.AUTHORIZATION,
      data,
      this.cfg.transactionTimeoutMs,
    );
    return this.buildPaymentResult(completion);
  }

  /** Reversal 06 30 of a same-day transaction by its receipt number. */
  async reversal(receiptNo: number): Promise<PaymentResult> {
    const data = Buffer.concat([
      digitStringToBcd(this.cfg.password),
      Buffer.from([0x87]),
      numberToBcd(receiptNo, 2),
    ]);
    const completion = await this.transact(CMD.REVERSAL, data, this.cfg.transactionTimeoutMs);
    return this.buildPaymentResult(completion);
  }

  /** End-of-day 06 50 (Kassenschnitt). */
  async endOfDay(): Promise<PaymentResult> {
    const data = digitStringToBcd(this.cfg.password);
    const completion = await this.transact(CMD.END_OF_DAY, data, 120_000);
    return this.buildPaymentResult(completion);
  }

  /** Abort 06 B0 — cancel a running payment from the ECR side. */
  async abort(): Promise<FrameTrace[]> {
    // Deliberately not using transact(): abort is sent while busy, and its frames
    // join the in-flight command's trace rather than starting a new one.
    await this.connect();
    const ack = this.waitForAck();
    this.send(CMD.ABORT, buildApdu(CMD.ABORT));
    await ack;
    return [...this.trace];
  }
}
