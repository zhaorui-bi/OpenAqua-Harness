import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { atomicWriteJson } from '../fs-utils';
import { packageVersion, resolveUserPath } from '../paths';
import type { OpenAquaBackend } from './backend';

export const ENGINEERING_RUN_SCHEMA_VERSION = 2;
export const ENGINEERING_RUN_MANIFEST = 'run-manifest.json';

export type EngineeringInputKind =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'missing'
  | 'other'
  | 'unreadable';

export interface EngineeringInputIdentity {
  readonly role: string;
  readonly reference: string;
  readonly path: string;
  readonly kind: EngineeringInputKind;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
  readonly sha256?: string;
  readonly entryCount?: number;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly integrityComplete?: boolean;
  readonly truncated?: boolean;
  readonly note?: string;
}

export interface EngineeringPayloadIdentity {
  readonly role: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface EngineeringScientificConfiguration {
  readonly resolution: 'adapter-reported-and-environment-overrides';
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly note: string;
}

export interface EngineeringJobRequest {
  readonly toolName: string;
  readonly operation: string;
  readonly backend: {
    readonly source: string;
    readonly command: readonly string[];
    readonly version?: string;
  };
  readonly requestedParameters: Readonly<Record<string, JsonValue>>;
  readonly inputs: readonly EngineeringInputIdentity[];
  readonly payloads: readonly EngineeringPayloadIdentity[];
  readonly scientificConfiguration?: Readonly<Record<string, JsonValue>>;
}

export interface EngineeringResultSnapshot {
  readonly capturedAt: string;
  readonly output: EngineeringInputIdentity;
  readonly resultSha256: string;
}

export interface EngineeringRunManifest {
  readonly schemaVersion: number;
  readonly kind: 'openaqua.engineering-run';
  readonly jobId: string;
  readonly createdAt: string;
  readonly toolName: string;
  readonly operation: string;
  readonly workDir: string;
  readonly command: readonly string[];
  readonly configuredOutput?: string;
  readonly backend: {
    readonly source: string;
    readonly command: readonly string[];
    readonly version?: string;
  };
  readonly runtime: {
    readonly harnessVersion: string;
    readonly nodeVersion: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
  };
  readonly parameters: {
    readonly resolution: 'requested-only';
    readonly values: Readonly<Record<string, JsonValue>>;
    readonly note: string;
  };
  readonly inputs: readonly EngineeringInputIdentity[];
  readonly payloads: readonly EngineeringPayloadIdentity[];
  readonly inputIntegrityComplete: boolean;
  readonly scientificConfiguration?: EngineeringScientificConfiguration;
  readonly requestSha256: string;
  readonly result?: EngineeringResultSnapshot;
}

export interface EngineeringManifestReadResult {
  readonly manifest?: EngineeringRunManifest;
  readonly error?: string;
}

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface InputReference {
  readonly role: string;
  readonly reference: string;
}

const MANIFEST_MAX_BYTES = 2_000_000;
const DIRECTORY_MAX_ENTRIES = 20_000;
const DIRECTORY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const NON_ENGINEERING_PARAMETERS = new Set(['wait', 'waitTimeoutMs']);

export function createEngineeringJobRequest(input: {
  readonly toolName: string;
  readonly operation: string;
  readonly backend: OpenAquaBackend;
  readonly backendVersion?: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly workDir: string;
  readonly scientificConfiguration?: Readonly<Record<string, unknown>>;
}): EngineeringJobRequest {
  const parameters: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input.args).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (NON_ENGINEERING_PARAMETERS.has(key) || value === undefined) continue;
    parameters[key] = toJsonValue(value, key);
  }

  const inputs = collectInputReferences(input.toolName, input.args).map((reference) =>
    fingerprintInput(reference, input.workDir),
  );
  const payloads = collectPayloadIdentities(input.args);
  return {
    toolName: input.toolName,
    operation: input.operation,
    backend: {
      source: input.backend.source,
      command: [...input.backend.command],
      version: input.backendVersion,
    },
    requestedParameters: parameters,
    inputs,
    payloads,
    scientificConfiguration:
      input.scientificConfiguration === undefined
        ? undefined
        : toJsonRecord(input.scientificConfiguration, 'scientificConfiguration'),
  };
}

export function buildEngineeringRunManifest(input: {
  readonly jobId: string;
  readonly createdAt: string;
  readonly command: readonly string[];
  readonly workDir: string;
  readonly configuredOutput?: string;
  readonly request: EngineeringJobRequest;
}): EngineeringRunManifest {
  const fingerprintPayload = {
    schemaVersion: ENGINEERING_RUN_SCHEMA_VERSION,
    toolName: input.request.toolName,
    operation: input.request.operation,
    backend: input.request.backend,
    command: [...input.command],
    workDir: input.workDir,
    configuredOutput: input.configuredOutput ?? null,
    requestedParameters: input.request.requestedParameters,
    inputs: input.request.inputs,
    payloads: input.request.payloads,
    scientificConfiguration: input.request.scientificConfiguration ?? null,
  };
  return {
    schemaVersion: ENGINEERING_RUN_SCHEMA_VERSION,
    kind: 'openaqua.engineering-run',
    jobId: input.jobId,
    createdAt: input.createdAt,
    toolName: input.request.toolName,
    operation: input.request.operation,
    workDir: input.workDir,
    command: [...input.command],
    configuredOutput: input.configuredOutput,
    backend: input.request.backend,
    runtime: {
      harnessVersion: packageVersion(),
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    parameters: {
      resolution: 'requested-only',
      values: input.request.requestedParameters,
      note:
        'These are the validated MCP request values. Preserve the OpenAqua checkout revision, downloaded dataset snapshot, generated indexes, model configuration, and backend-emitted result JSON before treating a workflow as frozen.',
    },
    inputs: input.request.inputs,
    payloads: input.request.payloads,
    inputIntegrityComplete: input.request.inputs.every(
      (identity) =>
        identity.kind === 'file' ||
        (identity.kind === 'directory' && identity.integrityComplete === true),
    ),
    scientificConfiguration:
      input.request.scientificConfiguration === undefined
        ? undefined
        : {
            resolution: 'adapter-reported-and-environment-overrides',
            values: input.request.scientificConfiguration,
            note:
              'Values are limited to non-secret adapter-reported settings and explicit environment overrides. API keys and credentials are never recorded.',
          },
    requestSha256: sha256(canonicalJson(fingerprintPayload)),
  };
}

export function readEngineeringRunManifest(filePath: string): EngineeringManifestReadResult {
  if (!existsSync(filePath)) return {};
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { error: 'run manifest is not a regular file' };
    }
    if (metadata.size > MANIFEST_MAX_BYTES) {
      return { error: `run manifest exceeds ${String(MANIFEST_MAX_BYTES)} bytes` };
    }
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isEngineeringRunManifest(value)) {
      return { error: 'run manifest does not match the OpenAqua engineering-run schema' };
    }
    if (value.requestSha256 !== requestFingerprint(value)) {
      return { error: 'run manifest request fingerprint does not match its contents' };
    }
    return { manifest: value };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function captureEngineeringRunOutput(
  manifestPath: string,
  configuredOutput: string,
): EngineeringResultSnapshot {
  const current = readEngineeringRunManifest(manifestPath);
  if (current.error !== undefined) throw new Error(current.error);
  if (current.manifest === undefined) throw new Error('run manifest is missing');
  const output = fingerprintResolvedPath(
    { role: 'configured-output', reference: configuredOutput },
    path.resolve(configuredOutput),
  );
  const result: EngineeringResultSnapshot = {
    capturedAt: new Date().toISOString(),
    output,
    resultSha256: sha256(canonicalJson(resultFingerprintPayload(output))),
  };
  atomicWriteJson(manifestPath, { ...current.manifest, result });
  return result;
}

function collectInputReferences(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): InputReference[] {
  const references: InputReference[] = [];
  const add = (role: string, key: string): void => {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') {
      references.push({ role, reference: value });
    }
  };

  switch (toolName) {
    case 'openaqua_recommend':
    case 'openaqua_retrieve_evidence':
      add('query', 'queryFile');
      break;
    case 'openaqua_ingest_knowledge':
      add('knowledge-record', 'dataFile');
      break;
    case 'openaqua_evaluate_trains':
    case 'openaqua_evaluate_retrieval':
      add('benchmark', 'benchmarkDir');
      add('predictions', 'predictions');
      break;
    case 'openaqua_audit_report':
      add('recommendation-report', 'reportFile');
      break;
  }
  return references;
}

function collectPayloadIdentities(
  args: Readonly<Record<string, unknown>>,
): EngineeringPayloadIdentity[] {
  const queryKeys = [
    'rawQuery',
    'sourceWater',
    'waterQuality',
    'contaminants',
    'treatmentTargets',
    'constraints',
    'context',
  ];
  const query: Record<string, unknown> = {};
  for (const key of queryKeys) {
    if (args[key] !== undefined) query[key] = args[key];
  }
  const payloads: EngineeringPayloadIdentity[] = [];
  if (Object.keys(query).length > 0) payloads.push(payloadIdentity('query', query));
  if (args['candidateChains'] !== undefined) {
    payloads.push(payloadIdentity('candidate-chains', args['candidateChains']));
  }
  return payloads;
}

function payloadIdentity(role: string, value: unknown): EngineeringPayloadIdentity {
  const rendered = canonicalJson(value);
  return { role, bytes: Buffer.byteLength(rendered), sha256: sha256(rendered) };
}

function fingerprintInput(
  reference: InputReference,
  workDir: string,
): EngineeringInputIdentity {
  return fingerprintResolvedPath(
    reference,
    resolveEngineeringPath(reference.reference, workDir),
  );
}

function fingerprintResolvedPath(
  reference: InputReference,
  resolvedPath: string,
): EngineeringInputIdentity {
  const base = { role: reference.role, reference: reference.reference, path: resolvedPath };
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(resolvedPath);
  } catch (error) {
    const code = errorCode(error);
    return { ...base, kind: code === 'ENOENT' ? 'missing' : 'unreadable', note: code ?? String(error) };
  }
  if (metadata.isSymbolicLink()) {
    return {
      ...base,
      kind: 'symlink',
      modifiedAt: metadata.mtime.toISOString(),
      note: 'Symbolic-link inputs are recorded but are not followed or hashed.',
    };
  }
  if (metadata.isDirectory()) {
    return {
      ...base,
      kind: 'directory',
      modifiedAt: metadata.mtime.toISOString(),
      ...fingerprintDirectory(resolvedPath),
    };
  }
  if (!metadata.isFile()) {
    return {
      ...base,
      kind: 'other',
      modifiedAt: metadata.mtime.toISOString(),
      note: 'Only regular-file inputs receive a content fingerprint.',
    };
  }

  try {
    const identity = fingerprintRegularFile(resolvedPath);
    return {
      ...base,
      kind: 'file',
      sizeBytes: identity.sizeBytes,
      modifiedAt: identity.modifiedAt,
      sha256: identity.sha256,
    };
  } catch (error) {
    return {
      ...base,
      kind: 'unreadable',
      sizeBytes: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      note: errorCode(error) ?? String(error),
    };
  }
}

function fingerprintRegularFile(filePath: string): {
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly sha256: string;
} {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, 'r');
    const metadata = fstatSync(descriptor);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return {
      sizeBytes: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      sha256: digest.digest('hex'),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fingerprintDirectory(directoryPath: string): Pick<
  EngineeringInputIdentity,
  | 'sha256'
  | 'entryCount'
  | 'fileCount'
  | 'totalBytes'
  | 'integrityComplete'
  | 'truncated'
  | 'note'
> {
  const digest = createHash('sha256');
  const issues = new Set<string>();
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  let truncated = false;
  let stopped = false;

  const visit = (currentPath: string, relativeBase: string): void => {
    let names: string[];
    try {
      names = readdirSync(currentPath).toSorted();
    } catch (error) {
      issues.add(`unreadable directory (${errorCode(error) ?? 'unknown error'})`);
      digest.update(`UNREADABLE_DIRECTORY\0${relativeBase}\n`);
      return;
    }

    for (const name of names) {
      if (stopped) return;
      if (entryCount >= DIRECTORY_MAX_ENTRIES) {
        truncated = true;
        stopped = true;
        issues.add(`entry limit ${String(DIRECTORY_MAX_ENTRIES)} reached`);
        digest.update(`ENTRY_LIMIT\0${String(DIRECTORY_MAX_ENTRIES)}\n`);
        return;
      }
      const fullPath = path.join(currentPath, name);
      const relativePath = path.join(relativeBase, name).split(path.sep).join('/');
      let metadata: ReturnType<typeof lstatSync>;
      try {
        metadata = lstatSync(fullPath);
      } catch (error) {
        entryCount += 1;
        issues.add(`unreadable entry (${errorCode(error) ?? 'unknown error'})`);
        digest.update(`UNREADABLE_ENTRY\0${relativePath}\n`);
        continue;
      }
      entryCount += 1;

      if (metadata.isSymbolicLink()) {
        issues.add('symbolic links were not followed');
        digest.update(`SYMLINK\0${relativePath}\n`);
        continue;
      }
      if (metadata.isDirectory()) {
        digest.update(`DIRECTORY\0${relativePath}\n`);
        visit(fullPath, relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        issues.add('non-regular entries were not hashed');
        digest.update(`OTHER\0${relativePath}\n`);
        continue;
      }
      if (totalBytes + metadata.size > DIRECTORY_MAX_BYTES) {
        truncated = true;
        stopped = true;
        issues.add(`byte limit ${String(DIRECTORY_MAX_BYTES)} reached`);
        digest.update(`BYTE_LIMIT\0${relativePath}\0${String(metadata.size)}\n`);
        return;
      }
      try {
        const file = fingerprintRegularFile(fullPath);
        fileCount += 1;
        totalBytes += file.sizeBytes;
        digest.update(
          `FILE\0${relativePath}\0${String(file.sizeBytes)}\0${file.sha256}\n`,
        );
      } catch (error) {
        issues.add(`unreadable file (${errorCode(error) ?? 'unknown error'})`);
        digest.update(`UNREADABLE_FILE\0${relativePath}\n`);
      }
    }
  };

  visit(directoryPath, '');
  const integrityComplete = issues.size === 0 && !truncated;
  return {
    sha256: digest.digest('hex'),
    entryCount,
    fileCount,
    totalBytes,
    integrityComplete,
    truncated,
    note: integrityComplete
      ? `Recursively hashed ${String(fileCount)} regular files (${String(totalBytes)} bytes).`
      : `Directory fingerprint is incomplete: ${[...issues].join('; ')}.`,
  };
}

function resolveEngineeringPath(value: string, workDir: string): string {
  const trimmed = value.trim();
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolveUserPath(trimmed);
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(workDir, trimmed);
}

function toJsonValue(value: unknown, pathLabel: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${pathLabel} must be finite`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => toJsonValue(entry, `${pathLabel}[${String(index)}]`));
  }
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (entry !== undefined) output[key] = toJsonValue(entry, `${pathLabel}.${key}`);
    }
    return output;
  }
  throw new Error(`${pathLabel} is not JSON-serializable`);
}

function toJsonRecord(
  value: Readonly<Record<string, unknown>>,
  pathLabel: string,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (entry !== undefined) output[key] = toJsonValue(entry, `${pathLabel}.${key}`);
  }
  return output;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isEngineeringRunManifest(value: unknown): value is EngineeringRunManifest {
  if (!isRecord(value)) return false;
  const schemaVersion = value['schemaVersion'];
  if (schemaVersion !== 1 && schemaVersion !== ENGINEERING_RUN_SCHEMA_VERSION) return false;
  const backend = value['backend'];
  const runtime = value['runtime'];
  const parameters = value['parameters'];
  const inputs = value['inputs'];
  const payloads = value['payloads'];
  const scientificConfiguration = value['scientificConfiguration'];
  const result = value['result'];
  return (
    value['kind'] === 'openaqua.engineering-run' &&
    typeof value['jobId'] === 'string' &&
    /^job_\d{14}_[a-z0-9]{6,16}$/.test(value['jobId']) &&
    typeof value['createdAt'] === 'string' &&
    Number.isFinite(Date.parse(value['createdAt'])) &&
    typeof value['toolName'] === 'string' &&
    value['toolName'].startsWith('openaqua_') &&
    typeof value['operation'] === 'string' &&
    value['operation'] !== '' &&
    typeof value['workDir'] === 'string' &&
    path.isAbsolute(value['workDir']) &&
    isStringArray(value['command']) &&
    (value['configuredOutput'] === undefined || typeof value['configuredOutput'] === 'string') &&
    isRecord(backend) &&
    typeof backend['source'] === 'string' &&
    isStringArray(backend['command']) &&
    (backend['version'] === undefined || typeof backend['version'] === 'string') &&
    isRecord(runtime) &&
    typeof runtime['harnessVersion'] === 'string' &&
    typeof runtime['nodeVersion'] === 'string' &&
    typeof runtime['platform'] === 'string' &&
    typeof runtime['architecture'] === 'string' &&
    isRecord(parameters) &&
    parameters['resolution'] === 'requested-only' &&
    isRecord(parameters['values']) &&
    Object.values(parameters['values']).every(isJsonValue) &&
    typeof parameters['note'] === 'string' &&
    Array.isArray(inputs) &&
    inputs.every(isEngineeringInputIdentity) &&
    (schemaVersion === 1 || inputs.every(isSchemaTwoInputIdentity)) &&
    Array.isArray(payloads) &&
    payloads.every(isEngineeringPayloadIdentity) &&
    typeof value['inputIntegrityComplete'] === 'boolean' &&
    (scientificConfiguration === undefined ||
      (schemaVersion === ENGINEERING_RUN_SCHEMA_VERSION &&
        isEngineeringScientificConfiguration(scientificConfiguration))) &&
    typeof value['requestSha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['requestSha256']) &&
    (result === undefined || isEngineeringResultSnapshot(result))
  );
}

function requestFingerprint(manifest: EngineeringRunManifest): string {
  const payload: Record<string, unknown> = {
    schemaVersion: manifest.schemaVersion,
    toolName: manifest.toolName,
    operation: manifest.operation,
    backend: manifest.backend,
    command: manifest.command,
    workDir: manifest.workDir,
    configuredOutput: manifest.configuredOutput ?? null,
    requestedParameters: manifest.parameters.values,
    inputs: manifest.inputs,
    payloads: manifest.payloads,
  };
  if (manifest.schemaVersion >= 2) {
    payload['scientificConfiguration'] = manifest.scientificConfiguration?.values ?? null;
  }
  return sha256(canonicalJson(payload));
}

function isEngineeringScientificConfiguration(
  value: unknown,
): value is EngineeringScientificConfiguration {
  return (
    isRecord(value) &&
    value['resolution'] === 'adapter-reported-and-environment-overrides' &&
    isRecord(value['values']) &&
    Object.values(value['values']).every(isJsonValue) &&
    typeof value['note'] === 'string'
  );
}

function isEngineeringInputIdentity(value: unknown): value is EngineeringInputIdentity {
  if (!isRecord(value)) return false;
  const kinds: readonly EngineeringInputKind[] = [
    'file',
    'directory',
    'symlink',
    'missing',
    'other',
    'unreadable',
  ];
  return (
    typeof value['role'] === 'string' &&
    typeof value['reference'] === 'string' &&
    typeof value['path'] === 'string' &&
    path.isAbsolute(value['path']) &&
    typeof value['kind'] === 'string' &&
    kinds.includes(value['kind'] as EngineeringInputKind) &&
    (value['sizeBytes'] === undefined ||
      (typeof value['sizeBytes'] === 'number' &&
        Number.isSafeInteger(value['sizeBytes']) &&
        value['sizeBytes'] >= 0)) &&
    (value['modifiedAt'] === undefined ||
      (typeof value['modifiedAt'] === 'string' && Number.isFinite(Date.parse(value['modifiedAt'])))) &&
    (value['sha256'] === undefined ||
      (typeof value['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(value['sha256']))) &&
    optionalNonnegativeInteger(value['entryCount']) &&
    optionalNonnegativeInteger(value['fileCount']) &&
    optionalNonnegativeInteger(value['totalBytes']) &&
    (value['integrityComplete'] === undefined || typeof value['integrityComplete'] === 'boolean') &&
    (value['truncated'] === undefined || typeof value['truncated'] === 'boolean') &&
    (value['note'] === undefined || typeof value['note'] === 'string')
  );
}

function isSchemaTwoInputIdentity(value: unknown): boolean {
  if (!isRecord(value) || value['kind'] !== 'directory') return true;
  return (
    typeof value['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['sha256']) &&
    typeof value['entryCount'] === 'number' &&
    Number.isSafeInteger(value['entryCount']) &&
    value['entryCount'] >= 0 &&
    typeof value['fileCount'] === 'number' &&
    Number.isSafeInteger(value['fileCount']) &&
    value['fileCount'] >= 0 &&
    typeof value['totalBytes'] === 'number' &&
    Number.isSafeInteger(value['totalBytes']) &&
    value['totalBytes'] >= 0 &&
    typeof value['integrityComplete'] === 'boolean' &&
    typeof value['truncated'] === 'boolean'
  );
}

function optionalNonnegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function resultFingerprintPayload(output: EngineeringInputIdentity): Record<string, unknown> {
  return {
    kind: output.kind,
    sizeBytes: output.sizeBytes,
    sha256: output.sha256,
    entryCount: output.entryCount,
    fileCount: output.fileCount,
    totalBytes: output.totalBytes,
    integrityComplete: output.integrityComplete,
    truncated: output.truncated,
  };
}

function isEngineeringResultSnapshot(value: unknown): value is EngineeringResultSnapshot {
  if (
    !isRecord(value) ||
    !isEngineeringInputIdentity(value['output']) ||
    !isSchemaTwoInputIdentity(value['output'])
  ) {
    return false;
  }
  return (
    typeof value['capturedAt'] === 'string' &&
    Number.isFinite(Date.parse(value['capturedAt'])) &&
    typeof value['resultSha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['resultSha256']) &&
    value['resultSha256'] ===
      sha256(canonicalJson(resultFingerprintPayload(value['output'])))
  );
}

function isEngineeringPayloadIdentity(value: unknown): value is EngineeringPayloadIdentity {
  return (
    isRecord(value) &&
    typeof value['role'] === 'string' &&
    typeof value['bytes'] === 'number' &&
    Number.isSafeInteger(value['bytes']) &&
    value['bytes'] >= 0 &&
    typeof value['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['sha256'])
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry !== '');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
