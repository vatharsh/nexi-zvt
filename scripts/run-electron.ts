import { spawn } from 'node:child_process';
import electronPath from 'electron';

const child = spawn(electronPath as unknown as string, ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TSX_TSCONFIG_PATH: 'tsconfig.electron.json',
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
