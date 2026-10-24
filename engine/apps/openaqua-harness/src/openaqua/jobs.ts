import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { atomicWriteJson, atomicWriteText } from '../fs-utils';
import { findPackageRoot, monorepoRoot, resolveUserPath } from '../paths';
import {
  buildEngineeringRunManifest,
  readEngineeringRunManifest,
  ENGINEERING_RUN_MANIFEST,
  type EngineeringJobRequest,
  type EngineeringManifestReadResult,
} from './provenance';

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface JobRecord {
  readonly id: string;
  readonly command: readonly string[];
  readonly workDir: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly label?: string;
}

export interface JobSnapshot {
  readonly id: string;
  readonly status: JobStatus;
  readonly command: readonly string[];
  readonly workDir: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly logPath: string;
  readonly dir: string;
  readonly label?: string;
}

export type JobLogView = 'raw' | 'errors' | 'events';

export interface JobLogReadOptions {
  readonly cursor?: number;
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly view?: JobLogView;
}

export interface JobLogExcerpt {
  readonly text: string;
  readonly view: JobLogView;
  readonly direction: 'tail' | 'forward';
  readonly cursor: number;
  readonly nextCursor?: number;
  readonly fileSize: number;
  readonly sourceBytes: number;
  readonly contentBytes: number;
  readonly sourceLines: number;
  readonly matchedLines: number;
  readonly truncated: boolean;
}

export interface JobArtifact {
  readonly relativePath: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size?: number;
  readonly modifiedAt: string;
}

export interface JobArtifactListing {
  readonly root?: string;
  readonly exists: boolean;
  readonly entries: readonly JobArtifact[];
  readonly truncated: boolean;
}

interface RunnerLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

interface JobCompletionRecord {
  readonly schemaVersion: 1;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals;
}

const JOB_ID_PATTERN = /^job_\d{14}_[a-z0-9]{6,16}$/;
const DEFAULT_LOG_TAIL_BYTES = 16_000;
const MAX_LOG_TAIL_BYTES = 1_000_000;
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2_000;
const DEFAULT_ARTIFACT_LIMIT = 200;
const MAX_ARTIFACT_LIMIT = 1_000;
const MAX_ARTIFACT_DEPTH = 8;
const CANCEL_GRACE_MS = 2_000;
const CANCEL_FORCE_WAIT_MS = 1_000;
const LOG_VIEW_PATTERNS: Readonly<Record<Exclude<JobLogView, 'raw'>, RegExp>> = {
  errors:
    /\b(?:error|exception|traceback|failed|failure|fatal|oom|out[ _-]?of[ _-]?memory|timed?[ _-]?out|cancelled)\b/i,
  events:
    /\b(?:start(?:ed|ing)?|submitted|queued|pending|running|progress|completed|finished|succeeded|failed|cancelled|parsed|retrieved|indexed|recommendation|candidate|precision|recall|f1|coverage|hit[ _-]?rate|summary)\b/i,
};

export function startJob(
  jobsRoot: string,
  command: readonly string[],
  options: {
    readonly workDir: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly label?: string;
    readonly provenance?: EngineeringJobRequest;
  },
): JobSnapshot {
  if (command.length === 0 || !command.every((part) => part !== '')) {
    throw new Error('Cannot start a job with an empty command');
  }
  if (!existsSync(options.workDir) || !statSync(options.workDir).isDirectory()) {
    throw new Error(`Job working directory does not exist or is not a directory: ${options.workDir}`);
  }

  const id = jobId();
  const root = path.resolve(jobsRoot);
  const dir = path.join(root, id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: false, mode: 0o700 });
  const logPath = path.join(dir, 'run.log');
  const exitCodePath = path.join(dir, 'exit.code');
  const completionPath = path.join(dir, 'completion.json');
  const runnerConfigPath = path.join(dir, 'runner.json');
  const workDir = path.resolve(options.workDir);
  const startedAt = new Date().toISOString();
  const configuredOutputPath = configuredOutput(command, workDir);
  const engineeringManifestPath =
    options.provenance === undefined ? undefined : path.join(dir, ENGINEERING_RUN_MANIFEST);
  try {
    if (options.provenance !== undefined && engineeringManifestPath !== undefined) {
      atomicWriteJson(
        engineeringManifestPath,
        buildEngineeringRunManifest({
          jobId: id,
          createdAt: startedAt,
          command,
          workDir,
          configuredOutput: configuredOutputPath,
          request: options.provenance,
        }),
      );
    }
    atomicWriteJson(runnerConfigPath, {
      command: [...command],
      workDir,
      logPath,
      exitCodePath,
      completionPath,
      engineeringManifestPath,
      configuredOutput:
        engineeringManifestPath === undefined ? undefined : configuredOutputPath,
      startedAt,
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  let child: ChildProcess;
  try {
    const launch = resolveRunnerLaunch();
    child = spawn(launch.command, [...launch.args, runnerConfigPath], {
      cwd: dir,
      env: options.env ?? process.env,
      detached: true,
      stdio: 'ignore',
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  child.unref();

  let launchFailureRecorded = false;
  const recordLaunchFailure = (message: string): void => {
    if (launchFailureRecorded) return;
    launchFailureRecorded = true;
    rmSync(runnerConfigPath, { force: true });
    appendFileSync(logPath, `${message}\n`, { mode: 0o600 });
    atomicWriteText(exitCodePath, '127');
  };
  child.once('error', (error) => {
    recordLaunchFailure(`failed to launch job runner: ${error.message}`);
  });

  const record: JobRecord = {
    id,
    command: [...command],
    workDir,
    pid: child.pid ?? -1,
    startedAt,
    label: options.label,
  };
  try {
    atomicWriteJson(path.join(dir, 'job.json'), record);
  } catch (error) {
    signalJobProcess(record.pid, 'SIGKILL', true);
    rmSync(runnerConfigPath, { force: true });
    throw error;
  }

  if (child.pid === undefined) {
    recordLaunchFailure('failed to launch job runner: no process id returned');
  }
  return snapshot(dir, record);
}

export function getJob(jobsRoot: string, id: string): JobSnapshot | undefined {
  const dir = safeJobDir(jobsRoot, id);
  if (dir === undefined) return undefined;
  const record = readJobRecord(path.join(dir, 'job.json'));
  if (record === undefined || record.id !== id) return undefined;
  return snapshot(dir, record);
}

export function listJobs(jobsRoot: string): JobSnapshot[] {
  if (!existsSync(jobsRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(jobsRoot);
  } catch {
    return [];
  }
  return entries
    .filter((id) => JOB_ID_PATTERN.test(id))
    .map((id) => getJob(jobsRoot, id))
    .filter((job): job is JobSnapshot => job !== undefined)
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function configuredJobOutput(job: JobSnapshot): string | undefined {
  return configuredOutput(job.command, job.workDir);
}

export function readJobRunManifest(
  jobsRoot: string,
  id: string,
): EngineeringManifestReadResult | undefined {
  const job = getJob(jobsRoot, id);
  if (job === undefined) return undefined;
  const result = readEngineeringRunManifest(path.join(job.dir, ENGINEERING_RUN_MANIFEST));
  if (result.manifest !== undefined && result.manifest.jobId !== id) {
    return { error: 'run manifest job id does not match its durable job directory' };
  }
  return result;
}

export function listJobArtifacts(
  jobsRoot: string,
  id: string,
  options: { readonly maxEntries?: number; readonly maxDepth?: number } = {},
): JobArtifactListing | undefined {
  const job = getJob(jobsRoot, id);
  if (job === undefined) return undefined;
  const root = configuredJobOutput(job);
  if (root === undefined) {
    return { root: undefined, exists: false, entries: [], truncated: false };
  }

  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch {
    return { root, exists: false, entries: [], truncated: false };
  }

  const maxEntries = boundedInteger(
    options.maxEntries,
    DEFAULT_ARTIFACT_LIMIT,
    1,
    MAX_ARTIFACT_LIMIT,
  );
  const maxDepth = boundedInteger(options.maxDepth, 4, 0, MAX_ARTIFACT_DEPTH);
  const entries: JobArtifact[] = [];
  let truncated = false;
  const append = (filePath: string, relativePath: string): boolean => {
    if (entries.length >= maxEntries) {
      truncated = true;
      return false;
    }
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(filePath);
    } catch {
      return true;
    }
    const type = metadata.isSymbolicLink()
      ? 'symlink'
      : metadata.isFile()
        ? 'file'
        : metadata.isDirectory()
          ? 'directory'
          : 'other';
    entries.push({
      relativePath,
      type,
      size: metadata.isFile() ? metadata.size : undefined,
      modifiedAt: metadata.mtime.toISOString(),
    });
    return true;
  };

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    append(root, path.basename(root));
    return { root, exists: true, entries, truncated };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return { root, exists: false, entries: [], truncated: false };
  }
  const visit = (directory: string, depth: number): void => {
    let names: string[];
    try {
      const canonicalDirectory = realpathSync(directory);
      const relativeDirectory = path.relative(canonicalRoot, canonicalDirectory);
      if (
        relativeDirectory.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeDirectory)
      ) {
        truncated = true;
        return;
      }
      const handle = opendirSync(directory);
      names = [];
      try {
        const remaining = maxEntries - entries.length;
        for (let count = 0; count <= remaining; count += 1) {
          const entry = handle.readSync();
          if (entry === null) break;
          if (count === remaining) {
            truncated = true;
            break;
          }
          names.push(entry.name);
        }
      } finally {
        handle.closeSync();
      }
      names.sort();
    } catch {
      truncated = true;
      return;
    }
    for (const name of names) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const fullPath = path.join(directory, name);
      const relativePath = path.relative(root, fullPath);
      let metadata: ReturnType<typeof lstatSync>;
      try {
        metadata = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (!append(fullPath, relativePath)) return;
        if (depth < maxDepth) {
          visit(fullPath, depth + 1);
        } else {
          truncated = true;
        }
      } else if (!append(fullPath, relativePath)) {
        return;
      }
    }
  };
  visit(root, 0);
  return { root, exists: true, entries, truncated };
}

export function jobLog(
  jobsRoot: string,
  id: string,
  tailBytes = DEFAULT_LOG_TAIL_BYTES,
): string | undefined {
  const excerpt = readJobLog(jobsRoot, id, {
    maxBytes: tailBytes,
    maxLines: MAX_LOG_LINES,
  });
  if (excerpt === undefined) return undefined;
  return excerpt.truncated
    ? `… (truncated, showing bounded log tail)\n${excerpt.text}`
    : excerpt.text;
}

export function readJobLog(
  jobsRoot: string,
  id: string,
  options: JobLogReadOptions = {},
): JobLogExcerpt | undefined {
  const dir = safeJobDir(jobsRoot, id);
  if (dir === undefined) return undefined;
  const logPath = path.join(dir, 'run.log');
  if (!isRegularFile(logPath)) return undefined;

  const maxBytes = boundedInteger(
    options.maxBytes,
    DEFAULT_LOG_TAIL_BYTES,
    1,
    MAX_LOG_TAIL_BYTES,
  );
  const maxLines = boundedInteger(options.maxLines, DEFAULT_LOG_LINES, 1, MAX_LOG_LINES);
  const view = options.view ?? 'raw';
  const direction = options.cursor === undefined ? 'tail' : 'forward';
  const descriptor = openSync(logPath, 'r');
  try {
    const fileSize = fstatSync(descriptor).size;
    const requestedCursor =
      direction === 'forward'
        ? boundedInteger(options.cursor, 0, 0, fileSize)
        : Math.max(0, fileSize - maxBytes);
    const bytesToRead = Math.min(fileSize - requestedCursor, maxBytes);
    const readBuffer = Buffer.alloc(bytesToRead);
    const bytesRead =
      bytesToRead > 0
        ? readSync(descriptor, readBuffer, 0, bytesToRead, requestedCursor)
        : 0;
    const source = readBuffer.subarray(0, bytesRead);

    let sourceCursor = requestedCursor;
    let boundedSource = source;
    if (direction === 'forward' && requestedCursor + source.length < fileSize) {
      const lastNewline = source.lastIndexOf(0x0a);
      if (lastNewline >= 0) boundedSource = source.subarray(0, lastNewline + 1);
    }
    // A tail normally starts in the middle of a record. Drop that partial
    // record when a newline is available instead of returning misleading text.
    if (direction === 'tail' && requestedCursor > 0) {
      const firstNewline = source.indexOf(0x0a);
      if (firstNewline >= 0 && firstNewline + 1 < source.length) {
        sourceCursor += firstNewline + 1;
        boundedSource = source.subarray(firstNewline + 1);
      }
    }

    const lines = splitLogLines(boundedSource);
    const pattern = view === 'raw' ? undefined : LOG_VIEW_PATTERNS[view];
    if (direction === 'forward') {
      const selected: Buffer[] = [];
      let processedBytes = 0;
      let sourceLines = 0;
      for (const line of lines) {
        processedBytes = line.end;
        sourceLines += 1;
        if (pattern === undefined || pattern.test(line.data.toString('utf8'))) {
          selected.push(line.data);
          if (selected.length >= maxLines) break;
        }
      }
      const nextOffset = sourceCursor + processedBytes;
      const nextCursor = nextOffset < fileSize ? nextOffset : undefined;
      return logExcerpt({
        selected,
        view,
        direction,
        cursor: sourceCursor,
        nextCursor,
        fileSize,
        sourceBytes: processedBytes,
        sourceLines,
        truncated: nextCursor !== undefined,
      });
    }

    const matching = lines.filter(
      (line) => pattern === undefined || pattern.test(line.data.toString('utf8')),
    );
    const selectedLines = matching.slice(-maxLines);
    const selected = selectedLines.map((line) => line.data);
    const cursor =
      selectedLines.length > 0
        ? sourceCursor + selectedLines[0]!.start
        : sourceCursor + boundedSource.length;
    return logExcerpt({
      selected,
      view,
      direction,
      cursor,
      fileSize,
      sourceBytes: boundedSource.length,
      sourceLines: lines.length,
      truncated: requestedCursor > 0 || matching.length > selectedLines.length,
    });
  } finally {
    closeSync(descriptor);
  }
}

export async function cancelJob(
  jobsRoot: string,
  id: string,
): Promise<JobSnapshot | undefined> {
  const job = getJob(jobsRoot, id);
  if (job === undefined) return undefined;
  if (job.status !== 'running') return job;

  if (pidAlive(job.pid) && !processMatchesJob(job.pid, job.dir)) {
    throw new Error(
      `Refusing to signal process ${String(job.pid)} because it no longer matches this job`,
    );
  }
  signalJobProcess(job.pid, 'SIGTERM', false);
  await waitForProcessExit(job.dir, job.pid, CANCEL_GRACE_MS);
  if (pidAlive(job.pid) && !isRegularFile(path.join(job.dir, 'exit.code'))) {
    if (!signalJobProcess(job.pid, 'SIGKILL', true)) {
      throw new Error(`Could not force-stop OpenAqua job process ${String(job.pid)}`);
    }
    await waitForProcessExit(job.dir, job.pid, CANCEL_FORCE_WAIT_MS);
  }
  if (pidAlive(job.pid) && !isRegularFile(path.join(job.dir, 'exit.code'))) {
    throw new Error(`OpenAqua job process ${String(job.pid)} did not terminate`);
  }
  atomicWriteText(path.join(job.dir, 'cancelled'), '');
  return getJob(jobsRoot, id);
}

export function waitForJob(
  jobsRoot: string,
  id: string,
  timeoutMs: number,
  pollMs = 5_000,
): Promise<JobSnapshot | undefined> {
  const boundedTimeout = Math.max(0, timeoutMs);
  const boundedPoll = Math.max(10, pollMs);
  const deadline = Date.now() + boundedTimeout;
  return new Promise((resolve) => {
    const tick = (): void => {
      const job = getJob(jobsRoot, id);
      if (
        job === undefined ||
        (job.status !== 'running' && job.status !== 'unknown') ||
        Date.now() >= deadline
      ) {
        resolve(job);
        return;
      }
      setTimeout(tick, boundedPoll);
    };
    tick();
  });
}

function resolveRunnerLaunch(): RunnerLaunch {
  const packageRoot = findPackageRoot();
  const built = path.join(packageRoot, 'dist', 'job-runner.mjs');
  if (existsSync(built)) return { command: process.execPath, args: [built] };

  const tsxCli = path.join(monorepoRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const source = path.join(packageRoot, 'src', 'openaqua', 'job-runner.ts');
  if (existsSync(tsxCli) && existsSync(source)) {
    return { command: process.execPath, args: [tsxCli, source] };
  }
  throw new Error('OpenAqua job runner is missing; rebuild openaqua-harness');
}

function safeJobDir(jobsRoot: string, id: string): string | undefined {
  if (!JOB_ID_PATTERN.test(id)) return undefined;
  const root = path.resolve(jobsRoot);
  const dir = path.join(root, id);
  try {
    if (!lstatSync(dir).isDirectory()) return undefined;
    const relative = path.relative(realpathSync(root), realpathSync(dir));
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    return dir;
  } catch {
    return undefined;
  }
}

function readJobRecord(filePath: string): JobRecord | undefined {
  if (!isRegularFile(filePath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record['id'] !== 'string' ||
      !JOB_ID_PATTERN.test(record['id']) ||
      !Array.isArray(record['command']) ||
      record['command'].length === 0 ||
      !record['command'].every((part) => typeof part === 'string' && part !== '') ||
      typeof record['workDir'] !== 'string' ||
      !path.isAbsolute(record['workDir']) ||
      !Number.isSafeInteger(record['pid']) ||
      typeof record['startedAt'] !== 'string' ||
      !Number.isFinite(Date.parse(record['startedAt'])) ||
      (record['label'] !== undefined && typeof record['label'] !== 'string')
    ) {
      return undefined;
    }
    return {
      id: record['id'],
      command: record['command'] as string[],
      workDir: record['workDir'],
      pid: record['pid'] as number,
      startedAt: record['startedAt'],
      label: record['label'],
    };
  } catch {
    return undefined;
  }
}

function snapshot(dir: string, record: JobRecord): JobSnapshot {
  const exitCodePath = path.join(dir, 'exit.code');
  const cancelledPath = path.join(dir, 'cancelled');
  const cancelled = existsSync(cancelledPath);
  const completion = readJobCompletion(path.join(dir, 'completion.json'));
  let status: JobStatus;
  let exitCode: number | undefined;
  let terminalMarkerPath: string | undefined;
  if (isRegularFile(exitCodePath)) {
    const parsed = Number.parseInt(readFileSync(exitCodePath, 'utf8').trim(), 10);
    if (Number.isSafeInteger(parsed)) exitCode = parsed;
    status = cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed';
    terminalMarkerPath = exitCodePath;
  } else if (completion !== undefined) {
    exitCode = completion.exitCode;
    status = cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed';
  } else if (cancelled) {
    status = 'cancelled';
    terminalMarkerPath = cancelledPath;
  } else if (record.pid > 0 && pidAlive(record.pid)) {
    status = 'running';
  } else {
    status = 'unknown';
  }

  let finishedAt = completion?.finishedAt;
  let durationMs = completion?.durationMs;
  if (completion === undefined && terminalMarkerPath !== undefined) {
    const completedMs = statSync(terminalMarkerPath).mtimeMs;
    const startedMs = Date.parse(record.startedAt);
    finishedAt = new Date(completedMs).toISOString();
    if (Number.isFinite(startedMs)) durationMs = Math.max(0, completedMs - startedMs);
  }
  return {
    id: record.id,
    status,
    command: record.command,
    workDir: record.workDir,
    pid: record.pid,
    startedAt: record.startedAt,
    finishedAt,
    durationMs,
    exitCode,
    signal: completion?.signal,
    logPath: path.join(dir, 'run.log'),
    dir,
    label: record.label,
  };
}

interface LogLine {
  readonly data: Buffer;
  readonly start: number;
  readonly end: number;
}

function configuredOutput(command: readonly string[], workDir: string): string | undefined {
  let configured: string | undefined;
  for (let index = command.length - 1; index >= 0; index -= 1) {
    const argument = command[index];
    if (argument === '--output') {
      configured = command[index + 1];
      break;
    }
    if (argument?.startsWith('--output=')) {
      configured = argument.slice('--output='.length);
      break;
    }
  }
  if (configured === undefined || configured.trim() === '') return undefined;
  const trimmed = configured.trim();
  return trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? resolveUserPath(trimmed)
    : path.resolve(workDir, trimmed);
}

function readJobCompletion(filePath: string): JobCompletionRecord | undefined {
  if (!isRegularFile(filePath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      record['schemaVersion'] !== 1 ||
      typeof record['finishedAt'] !== 'string' ||
      !Number.isFinite(Date.parse(record['finishedAt'])) ||
      typeof record['durationMs'] !== 'number' ||
      !Number.isFinite(record['durationMs']) ||
      record['durationMs'] < 0 ||
      typeof record['exitCode'] !== 'number' ||
      !Number.isSafeInteger(record['exitCode']) ||
      (record['signal'] !== undefined && typeof record['signal'] !== 'string')
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      finishedAt: record['finishedAt'],
      durationMs: record['durationMs'],
      exitCode: record['exitCode'],
      signal: record['signal'] as NodeJS.Signals | undefined,
    };
  } catch {
    return undefined;
  }
}

function splitLogLines(buffer: Buffer): LogLine[] {
  const lines: LogLine[] = [];
  let start = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline < 0 ? buffer.length : newline + 1;
    lines.push({ data: buffer.subarray(start, end), start, end });
    start = end;
  }
  return lines;
}

function logExcerpt(input: {
  readonly selected: readonly Buffer[];
  readonly view: JobLogView;
  readonly direction: 'tail' | 'forward';
  readonly cursor: number;
  readonly nextCursor?: number;
  readonly fileSize: number;
  readonly sourceBytes: number;
  readonly sourceLines: number;
  readonly truncated: boolean;
}): JobLogExcerpt {
  const contentBytes = input.selected.reduce((total, line) => total + line.length, 0);
  return {
    text: Buffer.concat(input.selected, contentBytes).toString('utf8'),
    view: input.view,
    direction: input.direction,
    cursor: input.cursor,
    nextCursor: input.nextCursor,
    fileSize: input.fileSize,
    sourceBytes: input.sourceBytes,
    contentBytes,
    sourceLines: input.sourceLines,
    matchedLines: input.selected.length,
    truncated: input.truncated,
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(value, maximum));
}

function isRegularFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function signalJobProcess(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
  forceWindows: boolean,
): boolean {
  if (pid <= 0) return false;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (forceWindows) args.push('/f');
    const result = spawnSync('taskkill', args, { stdio: 'ignore' });
    if (result.status === 0) return true;
    if (!forceWindows) return false;
  } else {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {}
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(dir: string, pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isRegularFile(path.join(dir, 'exit.code')) || !pidAlive(pid)) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function processMatchesJob(pid: number, jobDir: string): boolean {
  const marker = path.join(jobDir, 'runner.json');
  const inspection =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}").CommandLine`,
          ],
          { encoding: 'utf8', windowsHide: true },
        )
      : spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], {
          encoding: 'utf8',
        });
  return inspection.status === 0 && inspection.stdout.includes(marker);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function jobId(): string {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  return `job_${stamp}_${randomBytes(4).toString('hex')}`;
}
