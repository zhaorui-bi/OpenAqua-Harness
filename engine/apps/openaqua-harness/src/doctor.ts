import { accessSync, constants, existsSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { ASCII_LOGO } from './banner';
import { createOpenAquaHarness, resolveOpenAquaHome } from './harness';
import { resolveMcpLaunch } from './mcp/register';
import { defaultWebAssetsDir, packageVersion, resolveUserPath, skillsDir } from './paths';
import { validateProviderBaseUrl } from './providers';
import {
  backendRecommendationReady,
  describeBackend,
  probeBackend,
  resolveOpenAquaBackend,
  summarizeBackendHealth,
} from './openaqua/backend';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly required: boolean;
}

export interface DoctorReport {
  readonly version: string;
  readonly homeDir: string;
  readonly checks: readonly DoctorCheck[];
  readonly healthy: boolean;
}

export interface DoctorOptions {
  readonly probe?: boolean;
  readonly homeDir?: string;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const homeDir = resolveUserPath(options.homeDir ?? resolveOpenAquaHome());
  const checks: DoctorCheck[] = [];

  const nodeOk = nodeVersionAtLeast(24, 15);
  checks.push({
    name: 'node',
    ok: nodeOk,
    detail: `${process.version} (requires >= 24.15)`,
    required: true,
  });

  const homeExists = isDirectory(homeDir);
  checks.push({
    name: 'home_dir',
    ok: homeExists,
    detail: homeExists ? homeDir : `${homeDir} (missing — run \`openaqua onboard\`)`,
    required: true,
  });
  checks.push({
    name: 'home_writable',
    ok: homeExists && isReadableAndWritable(homeDir),
    detail: homeExists ? homeDir : 'home directory is missing',
    required: true,
  });

  const workDir = resolveUserPath(process.env['OPENAQUA_WORKDIR'] ?? process.cwd());
  const workDirOk = isDirectory(workDir) && isReadableAndWritable(workDir);
  checks.push({
    name: 'work_dir',
    ok: workDirOk,
    detail: workDirOk ? workDir : `${workDir} (missing, unreadable, or not writable)`,
    required: true,
  });

  const jobsDir = resolveUserPath(
    process.env['OPENAQUA_JOBS_DIR'] ?? path.join(workDir, 'openaqua-jobs'),
  );
  const jobsDirOk = writableDirectoryOrParent(jobsDir);
  checks.push({
    name: 'job_storage',
    ok: jobsDirOk,
    detail: jobsDirOk ? jobsDir : `${jobsDir} (no writable parent directory)`,
    required: true,
  });

  let modelDetail = 'not configured';
  let modelOk = false;
  let configWarnings: readonly string[] = [];
  const providerTransportIssues: string[] = [];
  if (homeExists) {
    const harness = createOpenAquaHarness(homeDir);
    try {
      const [config, diagnostics] = await Promise.all([
        harness.getConfig(),
        harness.getConfigDiagnostics(),
      ]);
      if (config.defaultModel !== undefined) {
        modelOk = true;
        modelDetail = config.defaultModel;
      }
      configWarnings = diagnostics.warnings;
      for (const [name, provider] of Object.entries(config.providers ?? {})) {
        if (provider.baseUrl === undefined) continue;
        try {
          validateProviderBaseUrl(provider.baseUrl);
        } catch (error) {
          providerTransportIssues.push(
            `${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error: unknown) {
      modelDetail = `failed to read config: ${String(error)}`;
    } finally {
      await harness.close();
    }
  }
  checks.push({ name: 'default_model', ok: modelOk, detail: modelDetail, required: true });
  checks.push({
    name: 'config_diagnostics',
    ok: configWarnings.length === 0,
    detail: configWarnings.length === 0 ? 'no warnings' : configWarnings.join('; '),
    required: false,
  });
  checks.push({
    name: 'provider_transport',
    ok: providerTransportIssues.length === 0,
    detail:
      providerTransportIssues.length === 0
        ? 'HTTPS or loopback HTTP'
        : providerTransportIssues.join('; '),
    required: true,
  });

  let backendDetail = 'not found';
  let backendOk = false;
  try {
    const backend = resolveOpenAquaBackend(process.env, homeDir);
    backendDetail = describeBackend(backend);
    backendOk = backend !== undefined;
    if (backend !== undefined && options.probe === true) {
      const probe = await probeBackend(backend);
      const ready = backendRecommendationReady(probe);
      backendOk = probe.code === 0 && ready !== false;
      const summary = summarizeBackendHealth(probe);
      backendDetail += backendOk
        ? ` — ${summary}`
        : ` — probe failed: ${summary}`;
      if (probe.timedOut) backendDetail += ' (timed out)';
    }
  } catch (error) {
    backendDetail = `invalid backend configuration: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({
    name: 'openaqua_backend',
    ok: backendOk,
    detail:
      backendDetail === 'not found'
        ? 'not found (set OPENAQUA_COMMAND / OPENAQUA_REPO, or install `openaqua` on PATH)'
        : backendDetail,
    required: true,
  });

  let mcpOk = true;
  let mcpDetail = '';
  try {
    const launch = resolveMcpLaunch();
    mcpDetail = `${launch.command} ${launch.args.join(' ')}`;
  } catch (error: unknown) {
    mcpOk = false;
    mcpDetail = String(error);
  }
  checks.push({ name: 'mcp_server_entry', ok: mcpOk, detail: mcpDetail, required: true });

  const webAssetsDir = resolveUserPath(
    process.env['OPENAQUA_WEB_ASSETS_DIR'] ?? defaultWebAssetsDir(),
  );
  const webOk = existsSync(path.join(webAssetsDir, 'index.html'));
  checks.push({
    name: 'web_ui_assets',
    ok: webOk,
    detail: webOk ? webAssetsDir : `${webAssetsDir} (missing — build/sync apps/kimi-code/dist-web)`,
    required: false,
  });

  const requiredSkills = ['openaqua/SKILL.md', 'openaqua-campaign/SKILL.md'];
  const missingSkills = requiredSkills.filter(
    (relativePath) => !isRegularFile(path.join(skillsDir(), relativePath)),
  );
  checks.push({
    name: 'skills',
    ok: missingSkills.length === 0,
    detail:
      missingSkills.length === 0
        ? `${skillsDir()} (${String(requiredSkills.length)} skills)`
        : `${skillsDir()} (missing: ${missingSkills.join(', ')})`,
    required: true,
  });

  const insecurePaths = insecurePrivatePaths(homeDir);
  checks.push({
    name: 'private_permissions',
    ok: insecurePaths.length === 0,
    detail:
      process.platform === 'win32'
        ? 'managed by Windows ACLs'
        : insecurePaths.length === 0
          ? 'private home/config permissions'
          : `group/world-accessible: ${insecurePaths.join(', ')}`,
    required: false,
  });

  return {
    version: packageVersion(),
    homeDir,
    checks,
    healthy: checks.every((c) => c.ok || !c.required),
  };
}

function nodeVersionAtLeast(requiredMajor: number, requiredMinor: number): boolean {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isReadableAndWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function writableDirectoryOrParent(directory: string): boolean {
  let candidate = path.resolve(directory);
  for (;;) {
    if (existsSync(candidate)) {
      return isDirectory(candidate) && isReadableAndWritable(candidate);
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

function insecurePrivatePaths(homeDir: string): string[] {
  if (process.platform === 'win32' || !existsSync(homeDir)) return [];
  const candidates = [
    homeDir,
    path.join(homeDir, 'config.toml'),
    path.join(homeDir, 'mcp.json'),
    path.join(homeDir, 'openaqua.json'),
    path.join(homeDir, 'credentials'),
    path.join(homeDir, 'oauth'),
  ];
  return candidates
    .filter((candidate) => {
      try {
        const metadata = lstatSync(candidate);
        return metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0;
      } catch {
        return false;
      }
    })
    .map((candidate) => path.relative(homeDir, candidate) || '.');
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    ASCII_LOGO,
    `  OpenAqua Harness ${report.version} — doctor`,
    `  home: ${report.homeDir}`,
    '',
  ];
  for (const check of report.checks) {
    const icon = check.ok ? '✓' : check.required ? '✗' : '⚠';
    lines.push(`  ${icon} ${check.name.padEnd(20)} ${check.detail}`);
  }
  lines.push('', report.healthy ? 'All required checks passed.' : 'Some required checks FAILED — see above.');
  return lines.join('\n');
}
