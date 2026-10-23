import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { startServer } from '@moonshot-ai/kap-server';

import { ASCII_LOGO } from './banner';
import { createOpenAquaHarness, ensureOpenAquaSkillDirs, resolveOpenAquaHome } from './harness';
import { ensureOpenAquaMcpJson } from './mcp/register';
import { defaultWebAssetsDir, packageVersion, resolveUserPath } from './paths';

export interface WebOptions {
  readonly host?: string;
  readonly port?: number;
  readonly noOpen?: boolean;
  readonly homeDir?: string;
}

const REPLY_STYLE_GUIDE = `You are the OpenAqua Harness agent: an AI copilot for early-stage water-treatment engineering research.
Prefer the openaqua_* MCP tools for taxonomy lookup, query normalization, hybrid evidence retrieval,
treatment-train recommendation, rule-based critique, knowledge staging, and WContBench evaluation.
Before launching work, verify source-water context, units, contaminants, treatment targets, operational
constraints, dataset paths, and acceptance criteria. Long operations run as durable background jobs:
use job list/status, manifests, bounded error/event log views, and artifact listings without busy-polling.
Start with status and a small validation case before larger evaluations. Ask for confirmation before
rebuilding indexes, staging knowledge, overwriting explicit output paths, or launching expensive model
calls. Never invent evidence, treatment performance, regulatory compliance, artifacts, completion states,
or metrics. Distinguish retrieved evidence from model synthesis, preserve assumptions and uncertainty,
and state that recommendations require expert review, local regulations, treatability testing, and
site-specific process design before implementation.`;

export async function runWeb(options: WebOptions): Promise<void> {
  const homeDir = resolveUserPath(options.homeDir ?? resolveOpenAquaHome());
  const host = validateHost(options.host ?? '127.0.0.1');
  const port = validatePort(options.port ?? 58_627);
  const webAssetsDir = resolveUserPath(
    process.env['OPENAQUA_WEB_ASSETS_DIR'] ?? defaultWebAssetsDir(),
  );
  if (!existsSync(path.join(webAssetsDir, 'index.html'))) {
    throw new Error(
      `Web UI assets not found at ${webAssetsDir}. Build or sync apps/kimi-code/dist-web in the kimi-code monorepo, or set OPENAQUA_WEB_ASSETS_DIR.`,
    );
  }

  const mcpJsonPath = ensureOpenAquaMcpJson(homeDir);
  const harness = createOpenAquaHarness(homeDir);
  try {
    await ensureOpenAquaSkillDirs(harness);
  } finally {
    await harness.close();
  }

  const version = packageVersion();
  const server = await startServer({
    host,
    port,
    homeDir,
    logLevel: 'silent',
    webTitle: 'OpenAqua Harness',
    webAssetsDir,
    serverVersion: version,
    telemetry: false,
    hostIdentity: {
      productName: 'openaqua-harness',
      version,
      platform: 'openaqua_harness',
      displayName: 'OpenAqua Harness',
      replyStyleGuide: REPLY_STYLE_GUIDE,
    },
  });

  const token = server.authTokenService.getToken();
  const url = localServerUrl(server.host, server.port, token);
  if (!isLoopbackHost(host)) {
    process.stderr.write(
      `warning: the server is listening on non-loopback host ${host}; keep the bearer URL private and use a firewall.\n`,
    );
  }
  process.stdout.write(
    [
      ASCII_LOGO,
      `  OpenAqua Harness server ready ${version}`,
      ``,
      `  Local:    ${url}`,
      ``,
      `  Home:     ${homeDir}`,
      `  MCP:      openaqua registered in ${mcpJsonPath}`,
      `  Stop:     Ctrl+C`,
      ``,
    ].join('\n'),
  );

  if (options.noOpen !== true) {
    openUrl(url);
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.close().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

function openUrl(url: string): void {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open';
  const args = [url];
  const child = spawn(opener, args, { detached: true, stdio: 'ignore' });
  child.once('error', (error) => {
    process.stderr.write(`warning: could not open a browser: ${error.message}\n`);
  });
  child.unref();
}

function validateHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === '' || /[\s/?#]/.test(trimmed)) {
    throw new Error(`Invalid web server host: ${host}`);
  }
  return trimmed;
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid web server port: ${String(port)} (expected 0-65535)`);
  }
  return port;
}

function localServerUrl(host: string, port: number, token: string): string {
  let browserHost = host;
  if (host === '0.0.0.0') browserHost = '127.0.0.1';
  if (host === '::' || host === '[::]') browserHost = '::1';
  const authority = browserHost.includes(':') ? `[${withoutBrackets(browserHost)}]` : browserHost;
  return `http://${authority}:${String(port)}/#token=${encodeURIComponent(token)}`;
}

function isLoopbackHost(host: string): boolean {
  const normalized = withoutBrackets(host).toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function withoutBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
