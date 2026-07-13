import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { MockScenario, PaymentResultDto, TerminalMode, ZvtSettings } from '../../shared/types';

interface HistoryItem {
  mode: TerminalMode;
  summary: string;
  result: PaymentResultDto;
}

const scenarios: MockScenario[] = ['approve', 'decline', 'decline-expired', 'timeout', 'slow', 'drop'];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {
  readonly scenarios = scenarios;
  readonly formatCents = formatCents;
  readonly config = signal<ZvtSettings>({
    mode: 'mock',
    real: { host: '', port: 20007, password: '000000' },
  });
  readonly amountText = signal('1,00');
  readonly busy = signal(false);
  readonly message = signal('');
  readonly statusLine = signal('Ready');
  readonly logs = signal<string[]>([]);
  readonly receiptLines = signal<string[]>([]);
  readonly result = signal<PaymentResultDto | null>(null);
  readonly history = signal<HistoryItem[]>([]);
  readonly mockScenario = signal<MockScenario>('approve');
  readonly mockStatus = signal<{ running: boolean; scenario: string; connections: number } | null>(null);
  readonly activeTab = signal<'pay' | 'settings' | 'result' | 'log'>('pay');
  private unsubs: Array<() => void> = [];
  private mockTimer?: number;
  private zvtApi = window.zvt;

  readonly activeProfile = computed(() => {
    const cfg = this.config();
    return cfg.mode === 'mock'
      ? { host: '127.0.0.1', port: 20007, password: '000000' }
      : cfg.real;
  });

  readonly amountError = computed(() => {
    try {
      parseAmountCents(this.amountText());
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  });

  async ngOnInit(): Promise<void> {
    if (!this.zvtApi) {
      this.message.set('Electron preload did not initialize. Rebuild Electron and restart the app.');
      this.statusLine.set('Bridge unavailable');
      return;
    }
    this.config.set(await this.zvtApi.getConfig());
    this.unsubs = [
      this.zvtApi.onStatus((s) => this.statusLine.set(s.text)),
      this.zvtApi.onLog((line) => this.logs.update((items) => [...items.slice(-499), line])),
      this.zvtApi.onPrintLine((line) => this.receiptLines.update((items) => [...items, line])),
      this.zvtApi.onDisconnected(() => this.statusLine.set('Disconnected')),
    ];
    await this.refreshMockStatus();
    this.mockTimer = window.setInterval(() => void this.refreshMockStatus(), 1500);
  }

  ngOnDestroy(): void {
    for (const unsub of this.unsubs) unsub();
    if (this.mockTimer) window.clearInterval(this.mockTimer);
  }

  async setMode(mode: TerminalMode): Promise<void> {
    if (this.config().mode === mode) return;
    this.message.set('');
    await this.zvtApi!.setMode(mode);
    this.config.update((cfg) => ({ ...cfg, mode }));
    this.statusLine.set(mode === 'mock' ? 'Mock terminal selected' : 'Real terminal selected');
    await this.refreshMockStatus();
  }

  async saveRealProfile(): Promise<void> {
    const cfg = this.config();
    await this.zvtApi!.setConfig(cfg);
    this.message.set('Settings saved');
  }

  updateRealHost(host: string): void {
    this.config.update((cfg) => ({ ...cfg, real: { ...cfg.real, host } }));
  }

  updateRealPort(port: string | number): void {
    this.config.update((cfg) => ({ ...cfg, real: { ...cfg.real, port: Number(port) || 20007 } }));
  }

  updateRealPassword(password: string): void {
    this.config.update((cfg) => ({ ...cfg, real: { ...cfg.real, password } }));
  }

  async connectAndRegister(): Promise<void> {
    this.busy.set(true);
    this.message.set('');
    try {
      const response = await this.zvtApi!.connectAndRegister();
      this.message.set(response.ok ? 'Connected and registered' : response.error);
    } finally {
      this.busy.set(false);
    }
  }

  async startPayment(): Promise<void> {
    const amountCents = parseAmountCents(this.amountText());
    this.busy.set(true);
    this.message.set('');
    this.receiptLines.set([]);
    this.statusLine.set('Starting payment');
    try {
      const result = await this.zvtApi!.startPayment(amountCents);
      this.captureResult(result, `Payment EUR ${formatCents(amountCents)}`);
      this.activeTab.set('result');
    } catch (e) {
      this.message.set((e as Error).message);
      this.statusLine.set('Payment failed');
    } finally {
      this.busy.set(false);
    }
  }

  async cancelPayment(): Promise<void> {
    await this.zvtApi!.cancelPayment();
    this.statusLine.set('Cancel requested');
  }

  async reverse(): Promise<void> {
    const receiptNo = this.result()?.receiptNo;
    if (!receiptNo) return;
    this.busy.set(true);
    try {
      const result = await this.zvtApi!.reversal(receiptNo);
      this.captureResult(result, `Reversal receipt ${receiptNo}`);
    } catch (e) {
      this.message.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async endOfDay(): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.zvtApi!.endOfDay();
      this.captureResult(result, 'End of day');
      this.activeTab.set('result');
    } catch (e) {
      this.message.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async setScenario(scenario: MockScenario): Promise<void> {
    this.mockScenario.set(scenario);
    await this.zvtApi!.mockSetScenario(scenario);
    await this.refreshMockStatus();
  }

  async copyRawStatus(): Promise<void> {
    const raw = this.result()?.rawStatusInformation;
    if (raw) await navigator.clipboard.writeText(raw);
  }

  async copyLog(): Promise<void> {
    await navigator.clipboard.writeText(this.logs().join('\n'));
  }

  trackLog(index: number): number {
    return index;
  }

  private captureResult(result: PaymentResultDto, summary: string): void {
    this.result.set(result);
    this.history.update((items) => [{ mode: result.mode, summary, result }, ...items].slice(0, 20));
    this.statusLine.set(result.resultText ?? (result.approved ? 'Approved' : 'Declined'));
  }

  private async refreshMockStatus(): Promise<void> {
    if (this.config().mode !== 'mock') {
      this.mockStatus.set(null);
      return;
    }
    try {
      const status = await this.zvtApi!.mockGetStatus();
      this.mockStatus.set(status);
      this.mockScenario.set(status.scenario as MockScenario);
    } catch {
      this.mockStatus.set(null);
    }
  }
}

export function parseAmountCents(input: string): number {
  const trimmed = input.trim();
  if (/^\d+[,.]\d{2}$/.test(trimmed)) {
    const [euros, cents] = trimmed.replace(',', '.').split('.');
    const value = Number.parseInt(euros, 10) * 100 + Number.parseInt(cents, 10);
    if (value <= 0) throw new Error('Amount must be greater than zero');
    return value;
  }
  if (/^\d+$/.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10) * 100;
    if (value <= 0) throw new Error('Amount must be greater than zero');
    return value;
  }
  throw new Error('Use whole euros or exactly two decimals, for example 1,00');
}

export function formatCents(amountCents: number): string {
  const euros = Math.floor(amountCents / 100);
  const cents = String(amountCents % 100).padStart(2, '0');
  return `${euros},${cents}`;
}
