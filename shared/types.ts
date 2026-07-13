import type { FrameTrace, MockScenario } from '@accurateitsolutionorg/nexi-zvt-client';
export type { FrameTrace, MockScenario };

export type TerminalMode = 'mock' | 'real';

export interface ConnectionProfile {
  host: string;
  port: number;
  password: string;
}

export interface ZvtSettings {
  mode: TerminalMode;
  real: ConnectionProfile;
}

export interface PaymentResultDto {
  mode: TerminalMode;
  approved: boolean;
  resultCode?: number;
  resultText?: string;
  amountCents?: number;
  traceNo?: number;
  originalTraceNo?: number;
  receiptNo?: number;
  turnoverNo?: number;
  date?: string;
  time?: string;
  expiry?: string;
  paymentType?: number;
  maskedPan?: string;
  cardSequenceNo?: number;
  cardType?: number;
  cardTypeName?: string;
  cardName?: string;
  terminalId?: string;
  vuNumber?: string;
  aid?: string;
  additionalText?: string;
  currency?: string;
  merchantReceipt: string[];
  customerReceipt: string[];
  rawStatusInformation?: string;
  unparsedRemainder?: string;
  otherBmps: { tag: number; value: string }[];
  trace: FrameTrace[];
}

export interface ZvtApi {
  getConfig(): Promise<ZvtSettings>;
  setConfig(cfg: ZvtSettings): Promise<void>;
  setMode(mode: TerminalMode): Promise<void>;
  connectAndRegister(): Promise<{ ok: true; trace: FrameTrace[] } | { ok: false; error: string; trace: FrameTrace[] }>;
  startPayment(amountCents: number): Promise<PaymentResultDto>;
  cancelPayment(): Promise<FrameTrace[]>;
  reversal(receiptNo: number): Promise<PaymentResultDto>;
  endOfDay(): Promise<PaymentResultDto>;
  mockSetScenario(s: MockScenario): Promise<void>;
  mockGetStatus(): Promise<{ running: boolean; scenario: string; connections: number }>;
  onStatus(cb: (s: { code: number; text: string }) => void): () => void;
  onLog(cb: (line: string) => void): () => void;
  onPrintLine(cb: (line: string) => void): () => void;
  onDisconnected(cb: () => void): () => void;
}
