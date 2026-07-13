import { BrowserWindow, app, ipcMain } from 'electron';
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockTerminal, toHex, ZvtClient, type PaymentResult } from '@accurateitsolutionorg/nexi-zvt-client';
import type { MockScenario, PaymentResultDto, TerminalMode, ZvtSettings } from '../shared/types.js';
import { loadSettings, profileForMode, saveSettings } from './settings.js';

let settings: ZvtSettings;
let client: ZvtClient | undefined;
let mock: MockTerminal | undefined;
let operationMode: TerminalMode = 'mock';

function send(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

async function writeLog(line: string): Promise<void> {
  const dir = app.getPath('userData');
  const date = new Date().toISOString().slice(0, 10);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `zvt-${date}.log`), `${line}\n`);
}

function attachClientEvents(next: ZvtClient): void {
  next.on('log', (line) => {
    send('zvt:log', line);
    void writeLog(line);
  });
  next.on('status', (status) => send('zvt:status', status));
  next.on('printLine', (line) => send('zvt:printLine', line));
  next.on('disconnected', () => send('zvt:disconnected'));
}

function ensureClient(): ZvtClient {
  const profile = profileForMode(settings, operationMode);
  if (!profile.host) throw new Error('Real terminal host is not configured');
  if (!client) {
    client = new ZvtClient(profile);
    attachClientEvents(client);
  }
  return client;
}

function resetClient(): void {
  client?.disconnect();
  client = undefined;
}

async function ensureMockState(): Promise<void> {
  if (operationMode === 'mock') {
    mock ??= new MockTerminal();
    await mock.start();
    return;
  }
  if (mock) {
    await mock.stop();
    mock = undefined;
  }
}

function dto(result: PaymentResult): PaymentResultDto {
  return {
    ...result,
    mode: operationMode,
    otherBmps: result.otherBmps.map((bmp) => ({ tag: bmp.tag, value: toHex(bmp.value) })),
    unparsedRemainder: result.unparsedRemainder ? toHex(result.unparsedRemainder) : undefined,
  };
}

async function runTransaction(fn: (c: ZvtClient) => Promise<PaymentResult>): Promise<PaymentResultDto> {
  const c = ensureClient();
  return dto(await fn(c));
}

export async function initializeIpc(): Promise<void> {
  settings = await loadSettings();
  operationMode = settings.mode;
  await ensureMockState();

  ipcMain.handle('zvt:getConfig', async () => settings);
  ipcMain.handle('zvt:setConfig', async (_event, cfg: ZvtSettings) => {
    settings = cfg;
    operationMode = cfg.mode;
    resetClient();
    await saveSettings(settings);
    await ensureMockState();
  });
  ipcMain.handle('zvt:setMode', async (_event, mode: TerminalMode) => {
    operationMode = mode;
    settings = { ...settings, mode };
    resetClient();
    await saveSettings(settings);
    await ensureMockState();
  });
  ipcMain.handle('zvt:connectAndRegister', async () => {
    let c: ZvtClient | undefined;
    try {
      c = ensureClient();
      await c.connect();
      const trace = await c.register();
      return { ok: true as const, trace };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, trace: c?.getLastTrace() ?? [] };
    }
  });
  ipcMain.handle('zvt:startPayment', async (_event, amountCents: number) => runTransaction((c) => c.payment(amountCents)));
  ipcMain.handle('zvt:cancelPayment', async () => ensureClient().abort());
  ipcMain.handle('zvt:reversal', async (_event, receiptNo: number) => runTransaction((c) => c.reversal(receiptNo)));
  ipcMain.handle('zvt:endOfDay', async () => runTransaction((c) => c.endOfDay()));
  ipcMain.handle('zvt:mockSetScenario', async (_event, scenario: MockScenario) => {
    if (operationMode === 'real') throw new Error('Mock control is unavailable in Real mode');
    mock ??= new MockTerminal();
    await mock.start();
    mock.setScenario(scenario);
  });
  ipcMain.handle('zvt:mockGetStatus', async () => {
    if (operationMode === 'real') throw new Error('Mock control is unavailable in Real mode');
    mock ??= new MockTerminal();
    await mock.start();
    return mock.getStatus();
  });
}

export async function shutdownIpc(): Promise<void> {
  resetClient();
  await mock?.stop();
}
