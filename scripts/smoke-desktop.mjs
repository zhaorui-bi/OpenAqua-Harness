#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await verifyDesktopStartupOutput();
if (process.argv[2] === '--check-startup') {
  process.stdout.write('Desktop startup: split output and bearer-token handling verified\n');
  process.exit(0);
}
const productVersion = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;
const executable = process.argv[2]
  ? path.resolve(process.argv[2])
  : findPackagedExecutable(path.join(root, 'dist'));
const resources = resourcesDirectory(executable);
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'openaqua-desktop-smoke-'));
const output = [];
let child;
let timeout;

try {
  assertFile(path.join(resources, 'app.asar'), 'application ASAR');
  for (const relativePath of [
    'harness/dist/cli.mjs',
    'harness/dist/mcp-server.mjs',
    'harness/dist/job-runner.mjs',
    'harness/dist/search-worker.mjs',
    'harness/skills/openaqua/SKILL.md',
    'harness/skills/openaqua-campaign/SKILL.md',
    'harness/backend/openaqua_cli.py',
    'web-ui/index.html',
    'web-ui/favicon.ico',
    'licenses/OPENAQUA_HARNESS_LICENSE',
    'licenses/KIMI_CODE_LICENSE',
    'licenses/OPENAQUA_UPSTREAM_LICENSE',
    'licenses/THIRD_PARTY_NOTICES.md',
    'licenses/SBOM.spdx.json',
    'licenses/ELECTRON_LICENSE',
    'licenses/ELECTRON_THIRD_PARTY_NOTICES.html',
  ]) {
    assertFile(path.join(resources, relativePath), `packaged resource ${relativePath}`);
  }
  assertPackagedVersions(resources, productVersion);
  assertNoPythonCache(path.join(resources, 'harness/backend'));
  assertSameFile(
    path.join(root, 'build/icon.ico'),
    path.join(resources, 'web-ui/favicon.ico'),
    'packaged Web favicon',
  );
  if (process.platform === 'darwin') {
    assertSameFile(
      path.join(root, 'build/icon.icns'),
      path.join(resources, 'icon.icns'),
      'packaged macOS application icon',
    );
  }

  const args = [
    '--smoke-test',
    `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`,
    '--disable-gpu',
  ];
  const launch = launchCommand(executable, args);
  child = spawn(launch.command, launch.args, {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      KIMI_LOG_LEVEL: 'off',
      OPENAQUA_DEBUG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  const result = await new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('packaged desktop smoke timed out')), 150_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);

  const combined = output.join('');
  if (!combined.includes('DESKTOP_SMOKE_OK')) {
    throw new Error('packaged application exited without its success marker');
  }
  if (result.code !== 0) {
    throw new Error(
      `packaged application exited with code ${String(result.code)} and signal ${String(result.signal)}`,
    );
  }
  const research = spawnSync(
    executable,
    [
      path.join(root, 'engine/apps/openaqua-harness/scripts/smoke-research.mjs'),
      path.join(resources, 'harness/dist/cli.mjs'),
    ],
    {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4_000_000,
    },
  );
  if (research.error !== undefined || research.status !== 0) {
    throw new Error(
      `Packaged research workflow failed: ${research.error?.message ?? redact(`${research.stdout ?? ''}\n${research.stderr ?? ''}`).slice(-12_000)}`,
    );
  }
  process.stdout.write(
    `Desktop smoke: packaged application, resources, and four-stage research workflow verified (${path.relative(root, executable)})\n`,
  );
} catch (error) {
  clearTimeout(timeout);
  await terminate(child);
  const diagnostic = redact(output.join('')).slice(-12_000);
  if (diagnostic !== '') process.stderr.write(`\n--- desktop output ---\n${diagnostic}\n`);
  throw error;
} finally {
  await terminate(child);
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function findPackagedExecutable(distDir) {
  const candidates = [];
  walk(distDir, 0, candidates);
  const match = candidates.find(isPlatformExecutable);
  if (match === undefined) {
    throw new Error(`could not find a packaged ${process.platform} executable under ${distDir}`);
  }
  return match;
}

function walk(directory, depth, files) {
  if (depth > 6 || !existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, depth + 1, files);
    else if (entry.isFile()) files.push(target);
  }
}

function isPlatformExecutable(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (process.platform === 'darwin') {
    return normalized.endsWith('/OpenAqua Harness.app/Contents/MacOS/OpenAqua Harness');
  }
  if (process.platform === 'win32') {
    return (
      normalized.includes('/win-unpacked/') &&
      path.basename(filePath).toLowerCase().includes('openaqua') &&
      filePath.toLowerCase().endsWith('.exe')
    );
  }
  if (!normalized.includes('/linux-unpacked/')) return false;
  try {
    accessSync(filePath, constants.X_OK);
    return path.basename(filePath).toLowerCase().includes('openaqua');
  } catch {
    return false;
  }
}

function resourcesDirectory(filePath) {
  if (process.platform === 'darwin') {
    return path.resolve(path.dirname(filePath), '..', 'Resources');
  }
  return path.join(path.dirname(filePath), 'resources');
}

function launchCommand(filePath, args) {
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    return { command: 'xvfb-run', args: ['-a', filePath, ...args] };
  }
  return { command: filePath, args };
}

function assertFile(filePath, label) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

function assertSameFile(expectedPath, actualPath, label) {
  assertFile(expectedPath, `${label} source`);
  assertFile(actualPath, label);
  if (sha256(expectedPath) !== sha256(actualPath)) {
    throw new Error(`${label} differs from ${expectedPath}`);
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function assertPackagedVersions(resourcesDirectoryPath, expectedVersion) {
  const adapterPath = path.join(
    resourcesDirectoryPath,
    'harness/backend/openaqua_cli.py',
  );
  const adapterVersion = /^ADAPTER_VERSION\s*=\s*["']([^"']+)["']$/m.exec(
    readFileSync(adapterPath, 'utf8'),
  )?.[1];
  if (adapterVersion !== expectedVersion) {
    throw new Error(
      `packaged adapter version mismatch: expected ${expectedVersion}, found ${String(adapterVersion)}`,
    );
  }

  const sbomPath = path.join(resourcesDirectoryPath, 'licenses/SBOM.spdx.json');
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
  const product = sbom.packages?.find(
    (candidate) => candidate.SPDXID === 'SPDXRef-OpenAqua-Harness',
  );
  if (product?.versionInfo !== expectedVersion) {
    throw new Error(
      `packaged SBOM version mismatch: expected ${expectedVersion}, found ${String(product?.versionInfo)}`,
    );
  }
}

function assertNoPythonCache(backendDirectory) {
  const files = [];
  walk(backendDirectory, 0, files);
  const cached = files.find(
    (filePath) =>
      filePath.endsWith('.pyc') ||
      filePath.includes(`${path.sep}__pycache__${path.sep}`),
  );
  if (cached !== undefined) {
    throw new Error(`packaged backend contains Python cache output: ${cached}`);
  }
}

async function terminate(processHandle) {
  if (
    processHandle === undefined ||
    processHandle.exitCode !== null ||
    processHandle.signalCode !== null
  ) {
    return;
  }
  processHandle.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => processHandle.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    processHandle.kill('SIGKILL');
  }
}

function redact(text) {
  return text.replace(/(#token=)[^\s]+/g, '$1<redacted>');
}

async function verifyDesktopStartupOutput() {
  const url = 'http://127.0.0.1:58627/#token=desktop-startup-test-token';
  const readyLine = `  Local:    ${url}\n`;
  for (let split = 1; split < readyLine.length; split++) {
    const probe = createStartupProbe();
    await probe.start();
    probe.child.stdout.emit('data', Buffer.from(readyLine.slice(0, split)));
    probe.child.stderr.emit('data', Buffer.from('interleaved diagnostic\n'));
    assert.equal(probe.url(), null, `readiness detected before complete line at split ${split}`);
    assert.deepEqual(probe.failures, [], `partial URL rejected at split ${split}`);
    probe.child.stdout.emit('data', Buffer.from(readyLine.slice(split)));
    assert.equal(probe.url(), url);
    assert.deepEqual(probe.loaded, [url]);
    assert.deepEqual(probe.failures, []);
    assert.ok(!probe.logs.join('').includes('desktop-startup-test-token'));
  }

  const stderrProbe = createStartupProbe();
  await stderrProbe.start();
  stderrProbe.child.stderr.emit('data', Buffer.from(`\u001b[32m${readyLine.trimEnd()}\u001b[0m\n`));
  assert.equal(stderrProbe.url(), url);

  const invalidProbe = createStartupProbe();
  await invalidProbe.start();
  invalidProbe.child.stdout.emit('data', Buffer.from('Local: http://example.test/#token=invalid\n'));
  assert.equal(invalidProbe.url(), null);
  assert.equal(invalidProbe.failures.length, 1);
  assert.deepEqual(invalidProbe.loaded, []);
}

function createStartupProbe() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const failures = [];
  const loaded = [];
  const logs = [];
  const nativeRequire = createRequire(path.join(root, 'main.js'));
  const app = {
    setName() {},
    getPath: () => os.tmpdir(),
    requestSingleInstanceLock: () => false,
    quit() {},
    isPackaged: false,
  };
  const probe = runInNewContext(
    `${readFileSync(path.join(root, 'main.js'), 'utf8')}
      aquaHomeDir = () => testDirectory;
      importExistingConfig = () => {};
      isUsableDirectory = () => true;
      showLoading = () => {};
      resolveEngineLaunch = () => ({ command: 'test-engine', args: [], env: {} });
      stopServer = async () => { serverProc = null; serverUrl = null; };
      handleServerFailure = (title) => failures.push(title);
      loadAppUrl = async (url) => { loaded.push(url); };
      ({ start: () => startServer(testDirectory, 0), url: () => serverUrl });`,
    {
      require: (name) =>
        name === 'electron'
          ? { app }
          : name === 'node:child_process'
            ? { spawn: () => child }
            : nativeRequire(name),
      __dirname: root,
      process: {
        argv: [],
        stdout: { write: (text) => logs.push(text) },
      },
      console: { log() {}, warn() {}, error() {} },
      Buffer,
      URL,
      setTimeout: () => 0,
      clearTimeout() {},
      testDirectory: os.tmpdir(),
      failures,
      loaded,
    },
    { filename: 'desktop-startup-probe.js' },
  );
  return { ...probe, child, failures, loaded, logs };
}
