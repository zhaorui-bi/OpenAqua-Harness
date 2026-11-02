#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// electron-winstaller still pulls temp 0.9.4's callback-only rimraf integration.
// Remove this patch with the rimraf override when that upstream chain supports
// current rimraf directly or no longer includes temp. Keep the source guards.
const sourcePath = require.resolve('temp/lib/temp.js');
const version = JSON.parse(readFileSync(require.resolve('temp/package.json'), 'utf8')).version;
const originalHash = 'ab00e9972ccbd639a4558519f40ad6839cb2c616b3da6cb9c12dea2828c6c9c9';
const patchedHash = 'c65cd1de8e8c9968019b7d2b0139b9308e3cab61b3c385b351edf523f559fbd9';
const source = readFileSync(sourcePath, 'utf8');
const digest = (text) => createHash('sha256').update(text).digest('hex');

if (version !== '0.9.4') throw new Error(`Review the temp compatibility patch for version ${version}`);
if (digest(source) !== patchedHash) {
  if (digest(source) !== originalHash) {
    throw new Error('The installed temp source differs from the reviewed upstream version');
  }
  const patched = source
    .replace("let rimraf     = require('rimraf');", "let rimraf     = require('rimraf').rimraf;")
    .replace('const rimrafSync = rimraf.sync;', "const rimrafSync = require('rimraf').rimrafSync;")
    .replaceAll('maxBusyTries: 6', 'maxRetries: 6')
    .replaceAll(
      'rimraf(toDelete, { maxRetries: 6 }, rimrafCallback);',
      'rimraf(toDelete, { maxRetries: 6 }).then(() => rimrafCallback(), rimrafCallback);',
    );
  if (digest(patched) !== patchedHash) throw new Error('The temp compatibility patch did not match');
  writeFileSync(sourcePath, patched);
}
process.stdout.write('Packaging dependency patch: temp cleanup uses the supported rimraf API\n');
