import { contextBridge, ipcRenderer } from 'electron';
import type { MockScenario, TerminalMode, ZvtApi, ZvtSettings } from '../shared/types.js';

function on<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api: ZvtApi = {
  getConfig: () => ipcRenderer.invoke('zvt:getConfig'),
  setConfig: (cfg: ZvtSettings) => ipcRenderer.invoke('zvt:setConfig', cfg),
  setMode: (mode: TerminalMode) => ipcRenderer.invoke('zvt:setMode', mode),
  connectAndRegister: () => ipcRenderer.invoke('zvt:connectAndRegister'),
  startPayment: (amountCents: number) => ipcRenderer.invoke('zvt:startPayment', amountCents),
  cancelPayment: () => ipcRenderer.invoke('zvt:cancelPayment'),
  reversal: (receiptNo: number) => ipcRenderer.invoke('zvt:reversal', receiptNo),
  endOfDay: () => ipcRenderer.invoke('zvt:endOfDay'),
  mockSetScenario: (s: MockScenario) => ipcRenderer.invoke('zvt:mockSetScenario', s),
  mockGetStatus: () => ipcRenderer.invoke('zvt:mockGetStatus'),
  onStatus: (cb) => on('zvt:status', cb),
  onLog: (cb) => on('zvt:log', cb),
  onPrintLine: (cb) => on('zvt:printLine', cb),
  onDisconnected: (cb) => on('zvt:disconnected', cb),
};

contextBridge.exposeInMainWorld('zvt', api);
