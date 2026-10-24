import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';

import { atomicWriteJson, atomicWriteText } from '../fs-utils';
import { captureEngineeringRunOutput } from './provenance';

interface JobRunnerConfig {
  readonly command: readonly string[];
  readonly workDir: string;
  readonly logPath: string;
  readonly exitCodePath: string;
  readonly completionPath?: string;
  readonly engineeringManifestPath?: string;
  readonly configuredOutput?: string;
  readonly startedAt?: string;
}

const configPath = process.argv[2];
if (configPath === undefined) {
  process.stderr.write('job runner requires a config path\n');
  process.exit(2);
}

let config: JobRunnerConfig;
try {
  config = parseConfig(configPath);
} catch (error) {
  process.stderr.write(`job runner config error: ${errorMessage(error)}\n`);
  process.exit(2);
}

rmSync(configPath, { force: true });
const logDescriptor = openSync(config.logPath, 'a', 0o600);
const [command, ...args] = config.command;
let finished = false;

const finish = (
  exitCode: number,
  message?: string,
  signal?: NodeJS.Signals | null,
): never => {
  if (finished) process.exit(exitCode);
  finished = true;
  if (message !== undefined) writeSync(logDescriptor, `${message}\n`);
  if (
    config.engineeringManifestPath !== undefined &&
    config.configuredOutput !== undefined
  ) {
    try {
      captureEngineeringRunOutput(
        config.engineeringManifestPath,
        config.configuredOutput,
      );
    } catch (error) {
      writeSync(
        logDescriptor,
        `could not capture configured output fingerprint: ${errorMessage(error)}\n`,
      );
    }
  }
  closeSync(logDescriptor);
  if (config.completionPath !== undefined) {
    const finishedAt = new Date().toISOString();
    const startedMs = config.startedAt === undefined ? Number.NaN : Date.parse(config.startedAt);
    atomicWriteJson(config.completionPath, {
      schemaVersion: 1,
      finishedAt,
      durationMs: Number.isFinite(startedMs) ? Math.max(0, Date.parse(finishedAt) - startedMs) : 0,
      exitCode,
      signal: signal ?? undefined,
    });
  }
  atomicWriteText(config.exitCodePath, String(exitCode));
  process.exit(exitCode);
};

const child = (() => {
  try {
    return spawn(command!, [...args], {
      cwd: config.workDir,
      env: process.env,
      detached: false,
      stdio: ['ignore', logDescriptor, logDescriptor],
    });
  } catch (error) {
    return finish(127, `failed to launch OpenAqua backend: ${errorMessage(error)}`);
  }
})();

const forwardSignal = (signal: NodeJS.Signals): void => {
  try {
    child.kill(signal);
  } catch {}
};

process.once('SIGTERM', () => {
  forwardSignal('SIGTERM');
});
process.once('SIGINT', () => {
  forwardSignal('SIGINT');
});

child.once('error', (error) => {
  finish(127, `failed to launch OpenAqua backend: ${error.message}`);
});
child.once('close', (code, signal) => {
  finish(code ?? signalExitCode(signal), undefined, signal);
});

function parseConfig(filePath: string): JobRunnerConfig {
  const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('config must be an object');
  }
  const record = value as Record<string, unknown>;
  const command = record['command'];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === 'string' && part !== '')
  ) {
    throw new Error('command must be a non-empty string array');
  }
  const engineeringManifestPath = optionalString(record, 'engineeringManifestPath');
  const configuredOutput = optionalString(record, 'configuredOutput');
  if ((engineeringManifestPath === undefined) !== (configuredOutput === undefined)) {
    throw new Error('engineeringManifestPath and configuredOutput must be provided together');
  }
  return {
    command: command as string[],
    workDir: requiredString(record, 'workDir'),
    logPath: requiredString(record, 'logPath'),
    exitCodePath: requiredString(record, 'exitCodePath'),
    completionPath: optionalString(record, 'completionPath'),
    engineeringManifestPath,
    configuredOutput,
    startedAt: optionalTimestamp(record, 'startedAt'),
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new Error(`${key} must be a string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new Error(`${key} must be a string`);
  return value;
}

function optionalTimestamp(record: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(record, key);
  if (value !== undefined && !Number.isFinite(Date.parse(value))) {
    throw new Error(`${key} must be an ISO timestamp`);
  }
  return value;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGKILL') return 137;
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
