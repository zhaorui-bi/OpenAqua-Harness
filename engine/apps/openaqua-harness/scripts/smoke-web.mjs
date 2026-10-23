#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.resolve(process.argv[2] ?? path.join(packageRoot, 'dist', 'cli.mjs'));
const webAssetsDir = path.resolve(
  process.argv[3] ?? path.join(path.dirname(path.dirname(cliPath)), 'web-ui'),
);
const workerPath = path.join(path.dirname(cliPath), 'search-worker.mjs');

assertFile(cliPath, 'built CLI');
assertFile(workerPath, 'global-search worker');
assertFile(path.join(webAssetsDir, 'index.html'), 'Web UI entry point');

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'openaqua-web-smoke-'));
const homeDir = path.join(temporaryRoot, 'home');
const output = [];
let child;

try {
  child = spawn(
    process.execPath,
    [cliPath, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0', '--home', homeDir],
    {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        KIMI_LOG_LEVEL: 'off',
        OPENAQUA_HOME: homeDir,
        OPENAQUA_WEB_ASSETS_DIR: webAssetsDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  const localUrl = await waitForServerUrl(child, output, 30_000);
  const url = new URL(localUrl);
  const token = decodeURIComponent(url.hash.slice('#token='.length));
  if (token === '') throw new Error('server URL did not contain a bearer token');

  const assetResponse = await fetch(`${url.origin}/`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!assetResponse.ok) {
    throw new Error(`Web UI entry point returned HTTP ${String(assetResponse.status)}`);
  }
  const assetHtml = await assetResponse.text();
  if (!assetHtml.includes('<title>OpenAqua Harness</title>')) {
    throw new Error('Web UI entry point is not the branded OpenAqua document');
  }

  const unauthorized = await fetch(`${url.origin}/api/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'OpenAqua' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (unauthorized.status !== 401) {
    throw new Error(
      `search endpoint accepted a request without its bearer token (HTTP ${String(unauthorized.status)})`,
    );
  }

  const response = await fetch(`${url.origin}/api/v1/search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: 'OpenAqua' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`search endpoint returned HTTP ${String(response.status)}`);
  }
  const envelope = await response.json();
  if (envelope?.code !== 0) {
    throw new Error(`search endpoint returned code ${String(envelope?.code)}`);
  }
  const indexState = envelope?.data?.index_state;
  if (indexState === undefined || indexState === null) {
    throw new Error('search endpoint omitted index_state');
  }
  if (typeof indexState.degraded === 'string' && indexState.degraded !== '') {
    throw new Error(`global search is degraded: ${indexState.degraded}`);
  }

  process.stdout.write(
    `Web smoke: server, bearer auth, assets, and global-search worker verified (${String(indexState.state)})\n`,
  );
} catch (error) {
  const diagnostic = redact(output.join('')).slice(-8_000);
  if (diagnostic !== '') process.stderr.write(`\n--- server output ---\n${diagnostic}\n`);
  throw error;
} finally {
  if (child !== undefined) await stopChild(child);
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
}

async function waitForServerUrl(server, chunks, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const text = chunks.join('');
    const match = /Local:\s+(http:\/\/\S+)/.exec(text);
    if (match?.[1] !== undefined) return match[1];
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `web server exited before startup (code=${String(server.exitCode)}, signal=${String(server.signalCode)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`web server did not become ready within ${String(timeoutMs)}ms`);
}

async function stopChild(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => server.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

function redact(text) {
  return text.replace(/(#token=)[^\s]+/g, '$1<redacted>');
}
