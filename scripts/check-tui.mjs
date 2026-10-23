#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = path.join(root, 'engine');
const appRoot = path.join(engineRoot, 'apps', 'kimi-code');
const tscEntry = path.join(engineRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const vitestEntry = path.join(engineRoot, 'node_modules', 'vitest', 'vitest.mjs');
const productVersion = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;

for (const [label, entry] of [
  ['TypeScript', tscEntry],
  ['Vitest', vitestEntry],
]) {
  if (!existsSync(entry)) {
    process.stderr.write(
      `TUI check: ${label} is unavailable at ${entry}. Run npm run setup first.\n`,
    );
    process.exit(1);
  }
}

const tests = [
  'test/tui/components/chrome/welcome.test.ts',
  'test/tui/components/editor/custom-editor.test.ts',
  'test/tui/components/messages/assistant-message.test.ts',
  'test/tui/components/messages/status-panel.test.ts',
  'test/tui/components/messages/user-message.test.ts',
  'test/tui/constant/tips.test.ts',
  'test/tui/kimi-tui-startup.test.ts',
  'test/tui/tmux-keyboard.test.ts',
  'test/tui/working-tips.test.ts',
];

const defaultEnv = { ...process.env };
delete defaultEnv['OPENAQUA_TUI'];
delete defaultEnv['OPENAQUA_VERSION'];

run('TUI typecheck', tscEntry, ['-p', 'tsconfig.json', '--noEmit'], defaultEnv);
run('Kimi host regression suite', vitestEntry, ['run', ...tests], defaultEnv);
run('OpenAqua host regression suite', vitestEntry, ['run', ...tests], {
  ...defaultEnv,
  OPENAQUA_TUI: '1',
  OPENAQUA_VERSION: productVersion,
});

process.stdout.write('TUI check: both interactive hosts passed.\n');

function run(label, entry, args, env) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: appRoot,
    env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
