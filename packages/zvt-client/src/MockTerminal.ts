import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { Apdu, ApduAssembler, buildAck, buildApdu, isAck, toHex } from './apdu.js';
import { amountToBcd, bcdToAmountCents, numberToBcd } from './bcd.js';
import { CMD } from './constants.js';
import type { MockScenario } from './types.js';

export interface MockTerminalOptions {
  host?: string;
  port?: number;
  scenario?: MockScenario;
  fixtureSink?: (frame: Buffer) => void;
}

interface Session {
  socket: net.Socket;
  assembler: ApduAssembler;
  ackWaiters: Array<() => void>;
  closed: boolean;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockTerminal extends EventEmitter {
  private server?: net.Server;
  private readonly host: string;
  private readonly port: number;
  private readonly fixtureSink?: (frame: Buffer) => void;
  private scenario: MockScenario;
  private sessions = new Set<Session>();
  private traceNo = 40;
  private receiptNo = 6;

  constructor(options: MockTerminalOptions = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 20007;
    this.scenario = options.scenario ?? 'approve';
    this.fixtureSink = options.fixtureSink;
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    this.server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const session of this.sessions) session.socket.destroy();
    this.sessions.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  setScenario(scenario: MockScenario): void {
    this.scenario = scenario;
  }

  getStatus(): { running: boolean; scenario: MockScenario; connections: number } {
    return {
      running: Boolean(this.server?.listening),
      scenario: this.scenario,
      connections: this.sessions.size,
    };
  }

  private onConnection(socket: net.Socket): void {
    socket.setNoDelay(true);
    const session: Session = {
      socket,
      assembler: new ApduAssembler(),
      ackWaiters: [],
      closed: false,
    };
    this.sessions.add(session);
    socket.on('data', (chunk) => this.onData(session, chunk));
    socket.on('close', () => {
      session.closed = true;
      for (const resolve of session.ackWaiters.splice(0)) resolve();
      this.sessions.delete(session);
    });
    socket.on('error', () => undefined);
  }

  private onData(session: Session, chunk: Buffer): void {
    let apdus: Apdu[];
    try {
      apdus = session.assembler.push(chunk);
    } catch {
      session.assembler.reset();
      void this.writeFrame(session, buildApdu(0x849a));
      return;
    }

    for (const apdu of apdus) {
      this.emit('log', `ECR -> PT ${toHex(apdu.raw)}`);
      if (isAck(apdu)) {
        session.ackWaiters.shift()?.();
        continue;
      }
      void this.handleCommand(session, apdu);
    }
  }

  private async handleCommand(session: Session, apdu: Apdu): Promise<void> {
    switch (apdu.ctrl) {
      case CMD.REGISTRATION:
        await this.writeFrame(session, buildAck());
        await this.sendTerminalMessage(session, CMD.COMPLETION);
        break;
      case CMD.AUTHORIZATION:
        await this.handleAuthorization(session, apdu);
        break;
      case CMD.REVERSAL:
      case CMD.END_OF_DAY:
        await this.writeFrame(session, buildAck());
        await this.sendTerminalMessage(session, CMD.STATUS_INFORMATION, this.statusPayload(0, 0));
        await this.sendTerminalMessage(session, CMD.COMPLETION);
        break;
      case CMD.ABORT:
        await this.writeFrame(session, buildAck());
        await this.sendTerminalMessage(session, CMD.ABORT_FROM_PT, Buffer.from([0x6c]));
        break;
      default:
        await this.writeFrame(session, buildAck());
        await this.sendTerminalMessage(session, CMD.ABORT_FROM_PT, Buffer.from([0x9a]));
    }
  }

  private async handleAuthorization(session: Session, apdu: Apdu): Promise<void> {
    const scenario = this.scenario;
    const amount = this.extractAmount(apdu.data);
    await this.writeFrame(session, buildAck());

    if (scenario === 'timeout') return;
    if (scenario === 'drop') {
      await delay(250);
      session.socket.destroy();
      return;
    }

    await delay(300);
    await this.sendTerminalMessage(session, CMD.INTERMEDIATE_STATUS, Buffer.from([0x0a]));
    await delay(scenario === 'slow' ? 2200 : 500);
    await this.sendTerminalMessage(session, CMD.INTERMEDIATE_STATUS, Buffer.from([0x04]));

    if (scenario === 'slow') {
      await delay(1800);
      await this.sendTerminalMessage(session, CMD.INTERMEDIATE_STATUS, Buffer.from([0x0e]));
      await delay(2600);
      await this.sendTerminalMessage(session, CMD.INTERMEDIATE_STATUS, Buffer.from([0x41]));
    } else {
      await delay(700);
    }

    if (scenario === 'decline' || scenario === 'decline-expired') {
      const code = scenario === 'decline-expired' ? 0x78 : 0x6c;
      await this.sendTerminalMessage(session, CMD.STATUS_INFORMATION, this.statusPayload(amount, code));
      await this.sendTerminalMessage(session, CMD.ABORT_FROM_PT, Buffer.from([code]));
      return;
    }

    await this.sendTerminalMessage(session, CMD.STATUS_INFORMATION, this.statusPayload(amount, 0x00));
    await this.sendTerminalMessage(session, CMD.PRINT_LINE, this.printLine('Nexi Germany Test'));
    await this.sendTerminalMessage(session, CMD.PRINT_LINE, this.printLine(`Betrag EUR ${this.formatAmount(amount)}`));
    await this.sendTerminalMessage(session, CMD.COMPLETION);
  }

  private async sendTerminalMessage(session: Session, ctrl: number, data: Uint8Array = Buffer.alloc(0)): Promise<void> {
    const ack = this.waitForEcrAck(session);
    await this.writeFrame(session, buildApdu(ctrl, data));
    await ack;
  }

  private waitForEcrAck(session: Session): Promise<void> {
    if (session.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      session.ackWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async writeFrame(session: Session, frame: Buffer): Promise<void> {
    if (session.closed || session.socket.destroyed) return;
    this.fixtureSink?.(frame);
    this.emit('log', `PT -> ECR ${toHex(frame)}`);
    const chunks = this.split(frame);
    for (const chunk of chunks) {
      if (session.closed || session.socket.destroyed) return;
      session.socket.write(chunk);
      await delay(5 + Math.floor(Math.random() * 16));
    }
  }

  private split(frame: Buffer): Buffer[] {
    if (frame.length <= 2) return [frame];
    const pieces = 1 + Math.floor(Math.random() * Math.min(3, frame.length));
    if (pieces === 1) return [frame];
    const chunks: Buffer[] = [];
    let offset = 0;
    for (let i = 0; i < pieces - 1; i++) {
      const remaining = frame.length - offset;
      const size = 1 + Math.floor(Math.random() * Math.max(1, remaining - (pieces - i - 1)));
      chunks.push(frame.subarray(offset, offset + size));
      offset += size;
    }
    chunks.push(frame.subarray(offset));
    return chunks;
  }

  private extractAmount(data: Buffer): number {
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x04 && i + 6 < data.length) {
        return bcdToAmountCents(data.subarray(i + 1, i + 7));
      }
    }
    return 0;
  }

  private statusPayload(amountCents: number, resultCode: number): Buffer {
    if (resultCode === 0x00) {
      this.traceNo += 1;
      this.receiptNo += 1;
    }
    return Buffer.concat([
      Buffer.from([0x27, resultCode]),
      Buffer.from([0x04]),
      amountToBcd(Math.max(1, amountCents || 1)),
      Buffer.from([0x0b]),
      numberToBcd(this.traceNo, 3),
      Buffer.from([0x87]),
      numberToBcd(this.receiptNo, 2),
      Buffer.from([0x8a, 0x05]),
      Buffer.from([0x22, 0xf0, 0xf4, 0x54, 0x13, 0xee, 0xee]),
      Buffer.from([0x29, 0x12, 0x34, 0x56, 0x78]),
    ]);
  }

  private printLine(text: string): Buffer {
    return Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
  }

  private formatAmount(amountCents: number): string {
    const euros = Math.floor(amountCents / 100);
    const cents = String(amountCents % 100).padStart(2, '0');
    return `${euros},${cents}`;
  }
}
