import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliArgumentError, parseCliInvocation } from '../src/cli-args';
import { runDoctor, formatDoctorReport } from '../src/doctor';
import { atomicWriteText } from '../src/fs-utils';
import { ensureOpenAquaMcpJson, mcpEnvironment } from '../src/mcp/register';
import { runOnboard } from '../src/onboard';
import { resolveOpenAquaHome, resolveUserPath } from '../src/paths';
import { validateProviderBaseUrl } from '../src/providers';
import { openAquaTuiEnvironment } from '../src/tui';
import {
  findOnPath,
  parseCommand,
  readBackendConfig,
  runCommand,
  OpenAquaBackendConfigError,
} from '../src/openaqua/backend';
import {
  cancelJob,
  configuredJobOutput,
  getJob,
  jobLog,
  listJobArtifacts,
  listJobs,
  readJobLog,
  readJobRunManifest,
  startJob,
  waitForJob,
} from '../src/openaqua/jobs';
import { openAquaToolAnnotations, OPENAQUA_TOOLS } from '../src/openaqua/tools';

const tempDirs: string[] = [];
const harnessVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CLI arguments', () => {
  it('parses command-specific flags without consuming positionals as boolean values', () => {
    expect(parseCliInvocation(['web', '--port', '0', '--host=127.0.0.1', '--no-open'])).toEqual({
      kind: 'web',
      host: '127.0.0.1',
      port: 0,
      noOpen: true,
      homeDir: undefined,
    });
    expect(parseCliInvocation(['run', '--', '--design', 'a treatment train'])).toEqual({
      kind: 'run',
      prompt: '--design a treatment train',
    });
    expect(() => parseCliInvocation(['doctor', '--probe', 'unexpected'])).toThrow(
      CliArgumentError,
    );
  });

  it('rejects invalid ports, unknown flags and conflicting credentials', () => {
    expect(() => parseCliInvocation(['web', '--port', '70000'])).toThrow(/0 to 65535/);
    expect(() => parseCliInvocation(['doctor', '--unknown'])).toThrow(CliArgumentError);
    expect(() =>
      parseCliInvocation([
        'onboard',
        '--api-key',
        'secret',
        '--api-key-env',
        'API_KEY',
      ]),
    ).toThrow(/cannot be used together/);
    expect(() =>
      parseCliInvocation([
        'onboard',
        '--openaqua-command',
        '["python","adapter.py"]',
        '--openaqua-repo',
        '/tmp/OpenAqua',
      ]),
    ).toThrow(/cannot be used together/);
  });
});

describe('runtime paths and private persistence', () => {
  it('expands user paths without inheriting the upstream Kimi home', () => {
    expect(resolveUserPath('~/aqua-work')).toBe(path.join(homedir(), 'aqua-work'));
    expect(resolveOpenAquaHome({ OPENAQUA_HOME: '~/aqua-home' })).toBe(
      path.join(homedir(), 'aqua-home'),
    );
    expect(resolveOpenAquaHome({ KIMI_CODE_HOME: '/tmp/upstream-home' })).toBe(
      path.join(homedir(), '.openaqua'),
    );
  });

  it('launches the upstream engine under the isolated OpenAqua TUI identity', () => {
    expect(openAquaTuiEnvironment('/tmp/aqua-home', { PATH: '/usr/bin' })).toMatchObject({
      PATH: '/usr/bin',
      KIMI_CODE_HOME: '/tmp/aqua-home',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_DISABLE_TELEMETRY: '1',
      OPENAQUA_HOME: '/tmp/aqua-home',
      OPENAQUA_TUI: '1',
      OPENAQUA_VERSION: harnessVersion,
    });
  });

  it('tightens an existing atomic-write target instead of preserving broad permissions', () => {
    if (process.platform === 'win32') return;
    const filePath = path.join(makeTempDir(), 'private.json');
    writeFileSync(filePath, 'old', { mode: 0o666 });
    chmodSync(filePath, 0o666);

    atomicWriteText(filePath, 'new');

    expect(readFileSync(filePath, 'utf8')).toBe('new');
    expect(lstatSync(filePath).mode & 0o077).toBe(0);
  });

  it('allows local HTTP model endpoints but requires HTTPS off-machine', () => {
    expect(validateProviderBaseUrl('http://127.0.0.1:8000/v1/')).toBe(
      'http://127.0.0.1:8000/v1',
    );
    expect(validateProviderBaseUrl('https://models.example.org/v1///')).toBe(
      'https://models.example.org/v1',
    );
    expect(() => validateProviderBaseUrl('http://models.example.org/v1')).toThrow(
      /must use https/,
    );
    expect(() => validateProviderBaseUrl('http://127.evil.example/v1')).toThrow(
      /must use https/,
    );
    expect(() => validateProviderBaseUrl('https://user:secret@example.org/v1')).toThrow(
      /embedded credentials/,
    );
  });

  it('onboards a clean home and passes a probed doctor report', async () => {
    const root = makeTempDir();
    const homeDir = path.join(root, 'home');
    const backendScript = path.join(root, 'fake-backend.mjs');
    writeFileSync(
      backendScript,
      "if (process.argv.includes('--version')) console.log('openaqua 0.test'); else console.log('{}');\n",
    );
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runOnboard({
        yes: true,
        homeDir,
        openaquaCommand: JSON.stringify([process.execPath, backendScript]),
        provider: 'custom',
        providerType: 'openai',
        baseUrl: 'http://127.0.0.1:9999/v1',
        model: 'acceptance-model',
        apiKeyEnv: 'OPENAQUA_TEST_API_KEY',
      });
      const report = await runDoctor({ homeDir, probe: true });
      expect(report.healthy).toBe(true);
      expect(report.checks.find((check) => check.name === 'default_model')).toMatchObject({
        ok: true,
        detail: 'custom-api/acceptance-model',
      });
      expect(report.checks.find((check) => check.name === 'openaqua_backend')).toMatchObject({
        ok: true,
      });
      expect(formatDoctorReport(report)).toContain('All required checks passed.');
      if (process.platform !== 'win32') {
        for (const fileName of ['config.toml', 'mcp.json', 'openaqua.json']) {
          expect(lstatSync(path.join(homeDir, fileName)).mode & 0o077).toBe(0);
        }
      }
    } finally {
      output.mockRestore();
    }
  });
});

describe('OpenAqua backend process handling', () => {
  it('parses JSON and quoted command forms and rejects malformed configuration', () => {
    expect(parseCommand('["uv","run","openaqua"]')).toEqual(['uv', 'run', 'openaqua']);
    expect(parseCommand('uv run --project "/tmp/repo with spaces" openaqua')).toEqual([
      'uv',
      'run',
      '--project',
      '/tmp/repo with spaces',
      'openaqua',
    ]);
    expect(() => parseCommand('[not-json]')).toThrow(OpenAquaBackendConfigError);

    const dir = makeTempDir();
    const configPath = path.join(dir, 'openaqua.json');
    writeFileSync(configPath, '{broken');
    expect(() => readBackendConfig(configPath)).toThrow(/left unchanged/);
  });

  it('resolves executables directly from PATH without invoking a shell', () => {
    const dir = makeTempDir();
    const executable = path.join(dir, 'openaqua-test');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    expect(findOnPath('openaqua-test', { PATH: dir })).toBe(executable);
  });

  it('bounds captured output and reports spawn errors as results', async () => {
    const output = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("abcdefghijklmnop")'],
      { maxOutputBytes: 8 },
    );
    expect(output.code).toBe(0);
    expect(output.stdoutTruncated).toBe(true);
    expect(output.stdout).toMatch(/ijklmnop$/);

    const missing = await runCommand(path.join(makeTempDir(), 'missing-command'), []);
    expect(missing.code).toBeNull();
    expect(missing.spawnError).toBeTruthy();
  });
});

describe('MCP configuration persistence', () => {
  it('preserves existing servers and writes the OpenAqua server atomically', () => {
    const homeDir = makeTempDir();
    const filePath = path.join(homeDir, 'mcp.json');
    writeFileSync(
      filePath,
      `${JSON.stringify({ mcpServers: { existing: { command: 'example' } }, custom: true })}\n`,
    );

    expect(ensureOpenAquaMcpJson(homeDir)).toBe(filePath);
    const config = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, any>;
    expect(config['custom']).toBe(true);
    expect(config['mcpServers']['existing']).toEqual({ command: 'example' });
    expect(config['mcpServers']['openaqua']['env']['OPENAQUA_HOME']).toBe(homeDir);
  });

  it('never overwrites malformed user configuration', () => {
    const homeDir = makeTempDir();
    const filePath = path.join(homeDir, 'mcp.json');
    writeFileSync(filePath, '{ malformed');

    expect(() => ensureOpenAquaMcpJson(homeDir)).toThrow(/left unchanged/);
    expect(readFileSync(filePath, 'utf8')).toBe('{ malformed');
  });

  it('forwards only the runtime overrides needed by the MCP server', () => {
    expect(
      mcpEnvironment('/tmp/home', {
        OPENAQUA_REPO: '/tmp/repo',
        OPENAQUA_WORKDIR: '/tmp/work',
        OPENROUTER_API_KEY: 'openrouter-test-key',
        UNRELATED_SECRET: 'do-not-copy',
      }),
    ).toEqual({
      OPENAQUA_HOME: '/tmp/home',
      OPENAQUA_REPO: '/tmp/repo',
      OPENAQUA_WORKDIR: '/tmp/work',
      OPENROUTER_API_KEY: 'openrouter-test-key',
    });
  });
});

describe('OpenAqua tool catalog', () => {
  it('publishes bounded water-treatment schemas and MCP safety annotations', () => {
    expect(OPENAQUA_TOOLS).toHaveLength(16);
    expect(new Set(OPENAQUA_TOOLS.map((tool) => tool.name)).size).toBe(16);

    const recommend = OPENAQUA_TOOLS.find((tool) => tool.name === 'openaqua_recommend');
    const constraints = OPENAQUA_TOOLS.find(
      (tool) => tool.name === 'openaqua_check_constraints',
    );
    const retrievalEval = OPENAQUA_TOOLS.find(
      (tool) => tool.name === 'openaqua_evaluate_retrieval',
    );
    expect(recommend?.inputSchema['waterQuality']).toBeDefined();
    expect(recommend?.inputSchema['topK']?.safeParse(11).success).toBe(false);
    expect(constraints?.inputSchema['candidateChains']?.safeParse([]).success).toBe(false);
    expect(retrievalEval?.inputSchema['kValues']?.safeParse([0]).success).toBe(false);
    expect(openAquaToolAnnotations('openaqua_catalog')).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(openAquaToolAnnotations('openaqua_normalize_query')).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(openAquaToolAnnotations('openaqua_job_manifest').readOnlyHint).toBe(true);
    expect(openAquaToolAnnotations('openaqua_job_cancel').destructiveHint).toBe(true);
    expect(openAquaToolAnnotations('openaqua_recommend').idempotentHint).toBe(false);
  });

  it('fails input preflight before launching a job with a missing query file', async () => {
    const root = makeTempDir();
    const workDir = path.join(root, 'work');
    const jobsRoot = path.join(root, 'jobs');
    mkdirSync(workDir);
    const recommend = OPENAQUA_TOOLS.find((tool) => tool.name === 'openaqua_recommend');
    if (recommend === undefined) throw new Error('recommend tool is missing');

    const result = await recommend.run(
      { queryFile: 'missing-query.json' },
      {
        jobsRoot,
        env: {
          OPENAQUA_COMMAND: JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
          OPENAQUA_WORKDIR: workDir,
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Input preflight failed');
    expect(listJobs(jobsRoot)).toEqual([]);
  });
});

describe('background jobs', () => {
  it('persists engineering request provenance with content fingerprints', async () => {
    const root = makeTempDir();
    const workDir = path.join(root, 'work');
    const jobsRoot = path.join(root, 'jobs');
    const queryPath = path.join(workDir, 'query.json');
    mkdirSync(workDir);
    const queryText = `${JSON.stringify({
      source_water: 'groundwater',
      contaminants: ['arsenic'],
      treatment_targets: { arsenic_ug_L: 10 },
      constraints: { brine_disposal: false, use_for_drinking: true },
    })}\n`;
    writeFileSync(queryPath, queryText);
    const recommend = OPENAQUA_TOOLS.find((tool) => tool.name === 'openaqua_recommend');
    if (recommend === undefined) throw new Error('recommend tool is missing');

    const launched = await recommend.run(
      {
        queryFile: 'query.json',
        topK: 2,
        output: 'recommendations.json',
        wait: false,
      },
      {
        jobsRoot,
        env: {
          OPENAQUA_COMMAND: JSON.stringify([
            process.execPath,
            '-e',
            'process.stdout.write("recommendation completed\\n")',
          ]),
          OPENAQUA_WORKDIR: workDir,
        },
      },
    );
    const content = launched.content[0];
    if (content === undefined) throw new Error('recommend tool returned no content');
    const payload = JSON.parse(content.text) as { job: { jobId: string } };
    const jobId = payload.job.jobId;
    const finished = await waitForJob(jobsRoot, jobId, 10_000, 20);
    expect(finished?.status).toBe('succeeded');

    const engineering = readJobRunManifest(jobsRoot, jobId);
    expect(engineering?.error).toBeUndefined();
    expect(engineering?.manifest).toMatchObject({
      schemaVersion: 1,
      kind: 'openaqua.engineering-run',
      jobId,
      toolName: 'openaqua_recommend',
      operation: 'recommend',
      configuredOutput: path.join(workDir, 'recommendations.json'),
      inputIntegrityComplete: true,
    });
    expect(engineering?.manifest?.backend.version).toBe(process.version);
    expect(engineering?.manifest?.parameters.resolution).toBe('requested-only');
    expect(engineering?.manifest?.parameters.values['wait']).toBeUndefined();
    expect(engineering?.manifest?.parameters.values['topK']).toBe(2);
    expect(engineering?.manifest?.inputs[0]).toMatchObject({
      role: 'query',
      path: queryPath,
      kind: 'file',
      sizeBytes: Buffer.byteLength(queryText),
    });
    expect(engineering?.manifest?.inputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(engineering?.manifest?.requestSha256).toMatch(/^[a-f0-9]{64}$/);

    const manifestTool = OPENAQUA_TOOLS.find(
      (tool) => tool.name === 'openaqua_job_manifest',
    );
    if (manifestTool === undefined) throw new Error('job manifest tool is missing');
    const inspected = await manifestTool.run({ jobId }, { jobsRoot, env: {} });
    const inspectedContent = inspected.content[0];
    if (inspectedContent === undefined) throw new Error('manifest tool returned no content');
    expect(JSON.parse(inspectedContent.text)).toMatchObject({
      engineeringRun: { jobId, inputIntegrityComplete: true },
      artifacts: { exists: false },
    });

    const manifestPath = path.join(finished!.dir, 'run-manifest.json');
    if (process.platform !== 'win32') {
      expect(lstatSync(manifestPath).mode & 0o077).toBe(0);
    }
    const tampered = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    tampered['operation'] = 'tampered';
    writeFileSync(manifestPath, JSON.stringify(tampered));
    expect(readJobRunManifest(jobsRoot, jobId)?.error).toMatch(/fingerprint/);
    expect((await manifestTool.run({ jobId }, { jobsRoot, env: {} })).isError).toBe(true);
  }, 15_000);

  it('runs through the detached runner and exposes bounded, cursor-based log views', async () => {
    const root = makeTempDir();
    const workDir = path.join(root, 'work');
    const jobsRoot = path.join(root, 'jobs');
    const output = 'started\nnoise\nERROR exploded\ncompleted\n';
    mkdirSync(workDir);

    const started = startJob(
      jobsRoot,
      [process.execPath, '-e', `process.stdout.write(${JSON.stringify(output)})`],
      { workDir, label: 'test-run' },
    );
    const finished = await waitForJob(jobsRoot, started.id, 10_000, 20);

    expect(finished?.status).toBe('succeeded');
    expect(finished?.finishedAt).toBeTruthy();
    expect(finished?.durationMs).toBeGreaterThanOrEqual(0);
    expect(jobLog(jobsRoot, started.id, 10)).toMatch(/completed\n$/);

    const first = readJobLog(jobsRoot, started.id, {
      cursor: 0,
      maxBytes: 1_000,
      maxLines: 2,
    });
    expect(first?.text).toBe('started\nnoise\n');
    expect(first?.nextCursor).toBe(Buffer.byteLength('started\nnoise\n'));

    const second = readJobLog(jobsRoot, started.id, {
      cursor: first?.nextCursor,
      maxBytes: 1_000,
      maxLines: 2,
    });
    expect(second?.text).toBe('ERROR exploded\ncompleted\n');
    expect(second?.nextCursor).toBeUndefined();

    const errors = readJobLog(jobsRoot, started.id, {
      cursor: 0,
      maxBytes: 1_000,
      view: 'errors',
    });
    expect(errors?.text).toBe('ERROR exploded\n');
    expect(errors?.matchedLines).toBe(1);

    expect(getJob(jobsRoot, '../job_20200101000000_abcdef')).toBeUndefined();
    expect(readJobLog(jobsRoot, '../../etc/passwd')).toBeUndefined();
    if (process.platform !== 'win32') {
      if (finished === undefined) throw new Error('job snapshot missing after completion');
      expect(lstatSync(finished.dir).mode & 0o077).toBe(0);
      const outside = path.join(root, 'outside');
      const symlinkId = 'job_20200101000000_abcdef';
      mkdirSync(outside);
      writeFileSync(
        path.join(outside, 'job.json'),
        JSON.stringify({
          id: symlinkId,
          command: ['echo', 'unsafe'],
          workDir,
          pid: -1,
          startedAt: new Date().toISOString(),
        }),
      );
      symlinkSync(outside, path.join(jobsRoot, symlinkId), 'dir');
      expect(getJob(jobsRoot, symlinkId)).toBeUndefined();
    }
  }, 15_000);

  it('recovers recent jobs and lists bounded output metadata without following links', async () => {
    const root = makeTempDir();
    const workDir = path.join(root, 'work');
    const jobsRoot = path.join(root, 'jobs');
    const outputDir = path.join(workDir, 'results');
    mkdirSync(workDir);
    const script = [
      'const fs = require("node:fs")',
      `fs.mkdirSync(${JSON.stringify(outputDir)}, { recursive: true })`,
      `fs.writeFileSync(${JSON.stringify(path.join(outputDir, 'result.txt'))}, "result")`,
    ].join(';');

    const started = startJob(
      jobsRoot,
      [process.execPath, '-e', script, '--', '--output', outputDir],
      { workDir, label: 'artifacts' },
    );
    const finished = await waitForJob(jobsRoot, started.id, 10_000, 20);
    expect(finished?.status).toBe('succeeded');
    expect(listJobs(jobsRoot)[0]?.id).toBe(started.id);

    if (process.platform !== 'win32') {
      const external = path.join(root, 'external-secret.txt');
      writeFileSync(external, 'do not read');
      symlinkSync(external, path.join(outputDir, 'external-link'));
    }
    const listing = listJobArtifacts(jobsRoot, started.id, { maxEntries: 10 });
    expect(listing?.root).toBe(outputDir);
    expect(
      configuredJobOutput({
        ...started,
        command: ['openaqua', '--output', 'first', '--output=last'],
      }),
    ).toBe(path.join(workDir, 'last'));
    expect(listing?.entries.some((entry) => entry.relativePath === 'result.txt')).toBe(true);
    if (process.platform !== 'win32') {
      expect(
        listing?.entries.find((entry) => entry.relativePath === 'external-link')?.type,
      ).toBe('symlink');
    }
    expect(listJobArtifacts(jobsRoot, started.id, { maxEntries: 1 })?.truncated).toBe(
      process.platform !== 'win32',
    );
  }, 15_000);

  it('refuses to cancel an unrelated process referenced by a stale job record', async () => {
    const root = makeTempDir();
    const jobsRoot = path.join(root, 'jobs');
    const jobId = 'job_20200101000000_deadbeef';
    const jobDir = path.join(jobsRoot, jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      path.join(jobDir, 'job.json'),
      JSON.stringify({
        id: jobId,
        command: ['openaqua', 'recommend'],
        workDir: root,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );

    await expect(cancelJob(jobsRoot, jobId)).rejects.toThrow(/no longer matches this job/);
  });

  it('cancels a process tree with a bounded graceful-to-forceful shutdown', async () => {
    const root = makeTempDir();
    const workDir = path.join(root, 'work');
    const jobsRoot = path.join(root, 'jobs');
    mkdirSync(workDir);
    const started = startJob(
      jobsRoot,
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { workDir, label: 'cancel-test' },
    );

    const cancelled = await cancelJob(jobsRoot, started.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(getJob(jobsRoot, started.id)?.status).toBe('cancelled');
  }, 15_000);
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'openaqua-harness-test-'));
  tempDirs.push(dir);
  return dir;
}
