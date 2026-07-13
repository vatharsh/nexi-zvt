import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TerminalMode, ZvtSettings } from '../shared/types.js';

const defaults: ZvtSettings = {
  mode: 'mock',
  real: {
    host: '',
    port: 20007,
    password: '000000',
  },
};

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<ZvtSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ZvtSettings>;
    return {
      mode: parsed.mode === 'real' ? 'real' : 'mock',
      real: {
        host: parsed.real?.host ?? defaults.real.host,
        port: Number(parsed.real?.port ?? defaults.real.port),
        password: parsed.real?.password ?? defaults.real.password,
      },
    };
  } catch {
    return defaults;
  }
}

export async function saveSettings(settings: ZvtSettings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2));
}

export function profileForMode(settings: ZvtSettings, mode: TerminalMode) {
  return mode === 'mock'
    ? { host: '127.0.0.1', port: 20007, password: '000000' }
    : settings.real;
}
