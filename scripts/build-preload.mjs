import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve('electron', 'preload.package.json');
const destination = resolve('dist-electron', 'preload', 'package.json');

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
