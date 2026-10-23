#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.resolve(process.argv[2] ?? path.join(packageRoot, 'dist', 'mcp-server.mjs'));
const scratch = mkdtempSync(path.join(tmpdir(), 'openaqua-mcp-smoke-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    ...process.env,
    OPENAQUA_HOME: path.join(scratch, 'home'),
    OPENAQUA_JOBS_DIR: path.join(scratch, 'jobs'),
    OPENAQUA_COMMAND: '',
    OPENAQUA_REPO: '',
  },
});
const client = new Client({ name: 'openaqua-mcp-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert(catalog.tools.length === 16, `expected 16 tools, found ${String(catalog.tools.length)}`);
  assert(
    new Set(catalog.tools.map((tool) => tool.name)).size === catalog.tools.length,
    'tool names are not unique',
  );
  const cancel = catalog.tools.find((tool) => tool.name === 'openaqua_job_cancel');
  assert(cancel?.annotations?.destructiveHint === true, 'cancel tool lacks destructive annotation');
  const manifest = catalog.tools.find((tool) => tool.name === 'openaqua_job_manifest');
  assert(manifest?.annotations?.readOnlyHint === true, 'manifest tool lacks read-only annotation');

  const jobs = await client.callTool({ name: 'openaqua_job_list', arguments: {} });
  const jobsText = jobs.content.find((item) => item.type === 'text')?.text ?? '';
  assert(jobsText.includes('"total": 0'), `unexpected empty job list: ${jobsText}`);

  const status = await client.callTool({ name: 'openaqua_status', arguments: {} });
  assert(status.content.some((item) => item.type === 'text'), 'status tool returned no text content');
  process.stdout.write('MCP smoke: 16 tools, annotations, dispatch, and empty job recovery verified\n');
} finally {
  await client.close().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
