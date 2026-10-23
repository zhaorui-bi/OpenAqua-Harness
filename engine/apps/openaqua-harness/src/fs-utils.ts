import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function atomicWriteText(
  filePath: string,
  contents: string,
  options: { readonly mode?: number } = {},
): void {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const requestedMode = options.mode ?? 0o600;
  const currentMode = existingMode(filePath);
  const mode = currentMode === undefined ? requestedMode : currentMode & requestedMode;
  const nonce = randomBytes(6).toString('hex');
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${String(process.pid)}.${nonce}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx', mode);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function existingMode(filePath: string): number | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}
