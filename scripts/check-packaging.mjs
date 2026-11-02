#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import * as asar from '@electron/asar';

const require = createRequire(import.meta.url);
const root = mkdtempSync(path.join(os.tmpdir(), 'openaqua-packaging-'));
const source = path.join(root, 'source');
const archive = path.join(root, 'app.asar');
const files = {
  'main.js': 'console.log("OpenAqua");\n',
  'lib/helper.js': 'export const units = "µg/L";\n',
  'data/quality.json': '{"arsenic_ug_L":150}\n',
  'native/addon.node': 'synthetic native-file fixture\n',
  'cache/ignored.json': '{}\n',
  'cache/__pycache__/adapter.pyc': 'cache fixture\n',
  '.hidden.json': '{}\n',
};

try {
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(source, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const filter = new FileMatcher(source, root, (pattern) => pattern, [
    '**/*', '!cache/**', '!**/*.pyc',
  ]).createFilter();
  for (const name of ['main.js', 'lib/helper.js', '.hidden.json']) {
    const candidate = path.join(source, name);
    assert.equal(filter(candidate, statSync(candidate)), true, `included resource ${name}`);
  }
  for (const name of ['cache/ignored.json', 'cache/__pycache__/adapter.pyc']) {
    const candidate = path.join(source, name);
    assert.equal(filter(candidate, statSync(candidate)), false, `excluded resource ${name}`);
  }

  await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' });
  for (const [name, content] of Object.entries(files)) {
    assert.equal(asar.extractFile(archive, name).toString(), content, `archive roundtrip ${name}`);
  }
  assert.equal(asar.statFile(archive, 'native/addon.node').unpacked, true);
  assert.equal(readFileSync(`${archive}.unpacked/native/addon.node`, 'utf8'), files['native/addon.node']);
  const { checkFileInArchive } = require('app-builder-lib/out/asar/asarFileChecker');
  assert.ok((await checkFileInArchive(archive, 'main.js', 'packaging check')).size > 0);

  const temp = require('temp').track();
  const asarRequire = createRequire(require.resolve('@electron/asar'));
  const glob = asarRequire('glob');
  const options = { cwd: source, dot: true, nodir: true, ignore: 'cache/**' };
  const expected = ['.hidden.json', 'data/quality.json', 'lib/helper.js', 'main.js'];
  const normalize = (names) => names.map((name) => name.split(path.sep).join('/')).sort();
  assert.deepEqual(normalize(glob.globSync('**/*.{js,json}', options)), expected);
  const asynchronous = await glob.glob('**/*.{js,json}', options);
  assert.deepEqual(normalize(asynchronous), expected);
  await assert.rejects(glob.glob('**/*', {
    cwd: source,
    signal: AbortSignal.abort(new Error('packaging traversal canceled')),
  }), /packaging traversal canceled/);
  const trackedDirectory = temp.mkdirSync('openaqua-packaging-cleanup-');
  writeFileSync(path.join(trackedDirectory, 'temporary-file'), 'temporary');
  await new Promise((resolve, reject) => {
    temp.cleanup((error) => error ? reject(error) : resolve());
  });
  assert.equal(existsSync(trackedDirectory), false);
  const syncDirectory = temp.mkdirSync('openaqua-packaging-sync-cleanup-');
  writeFileSync(path.join(syncDirectory, 'temporary-file'), 'temporary');
  temp.cleanupSync();
  assert.equal(existsSync(syncDirectory), false);

  const { FileList } = require('filelist');
  const javascript = new FileList(path.join(source, '**/*.js')).toArray();
  assert.deepEqual(normalize(javascript.map((name) => path.relative(source, name))), [
    'lib/helper.js', 'main.js',
  ]);
  const ejs = require('ejs');
  assert.equal(ejs.render('<%= label %>:<%= concentration %>', {
    label: '<water>', concentration: 150,
  }), '&lt;water&gt;:150');
  const universal = await import('@electron/universal');
  assert.equal(typeof universal.makeUniversalApp, 'function');
  process.stdout.write('Packaging check: archive roundtrip/unpack, resource filters, bounded glob/temp cleanup, and template consumers verified\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
