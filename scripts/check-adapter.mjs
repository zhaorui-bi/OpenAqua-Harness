#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'engine', 'apps', 'openaqua-harness', 'test-python');
const candidates = [];

if (process.env.OPENAQUA_PYTHON?.trim()) {
  candidates.push({ command: process.env.OPENAQUA_PYTHON.trim(), prefix: [] });
}
if (process.platform === 'win32') {
  candidates.push(
    { command: 'py', prefix: ['-3'] },
    { command: 'python', prefix: [] },
    { command: 'python3', prefix: [] },
  );
} else {
  candidates.push(
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] },
  );
}

const python = candidates.find(isSupportedPython);
if (python === undefined) {
  process.stderr.write('adapter check requires Python 3.10 or newer\n');
  process.exit(1);
}

const result = spawnSync(
  python.command,
  [
    ...python.prefix,
    '-m',
    'unittest',
    'discover',
    '-s',
    testDir,
    '-p',
    'test_*.py',
    '-v',
  ],
  {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    stdio: 'inherit',
  },
);
if (result.error !== undefined) {
  process.stderr.write(`adapter check could not start Python: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);

function isSupportedPython(candidate) {
  const result = spawnSync(
    candidate.command,
    [...candidate.prefix, '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'],
    { cwd: root, encoding: 'utf8', stdio: 'ignore' },
  );
  return result.status === 0;
}
