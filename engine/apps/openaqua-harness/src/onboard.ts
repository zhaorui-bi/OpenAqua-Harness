import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface, type Interface } from 'node:readline';

import { atomicWriteJson } from './fs-utils';
import { createOpenAquaHarness, ensureOpenAquaSkillDirs, resolveOpenAquaHome } from './harness';
import { ensureOpenAquaMcpJson } from './mcp/register';
import { resolveUserPath } from './paths';
import { applyApiProvider, PROVIDER_PRESETS } from './providers';
import {
  backendRecommendationReady,
  describeBackend,
  parseCommand,
  probeBackend,
  repoCommand,
  resolveOpenAquaBackend,
  summarizeBackendHealth,
  type OpenAquaBackend,
} from './openaqua/backend';

export interface OnboardOptions {
  readonly yes?: boolean;
  readonly homeDir?: string;
  readonly openaquaCommand?: string;
  readonly openaquaRepo?: string;
  readonly importFrom?: string;
  readonly provider?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly providerType?: 'anthropic' | 'openai' | 'kimi' | 'google-genai' | 'openai_responses' | 'vertexai';
}

const IMPORT_FILES = ['config.toml', 'credentials', 'oauth', 'tui.toml'];

export async function runOnboard(options: OnboardOptions): Promise<void> {
  const interactive = options.yes !== true && process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const homeDir = resolveUserPath(
      options.homeDir ?? (await ask(rl, 'OpenAqua home directory', resolveOpenAquaHome())),
    );
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(homeDir, 0o700);
    process.stdout.write(`home: ${homeDir}\n`);

    if (!existsSync(path.join(homeDir, 'config.toml'))) {
      const imported = await maybeImportCredentials(homeDir, options.importFrom, rl);
      if (!imported) {
        process.stdout.write(
          'no existing config imported — configure a model provider below (API key, no login required).\n',
        );
      }
    } else {
      process.stdout.write('config.toml: present\n');
    }

    await setupModel(homeDir, options, rl);

    const backend = await pickBackend(homeDir, options, rl);
    if (backend !== undefined) {
      process.stdout.write(`openaqua backend: ${describeBackend(backend)}\n`);
      const wrapperBased = backend.command[0] === 'uv' || backend.command[0] === 'pixi';
      if (wrapperBased) {
        process.stdout.write(
          'probe skipped: uv/pixi will create the python environment on first use (uv sync / pixi install) — this can download large ML dependencies.\n',
        );
      } else {
        const probe = await probeBackend(backend);
        const summary = summarizeBackendHealth(probe);
        const ready = backendRecommendationReady(probe);
        if (probe.code === 0 && ready !== false) {
          process.stdout.write(`probe: ${summary}\n`);
        } else if (probe.code === 0) {
          process.stdout.write(
            `probe incomplete (${summary}); the backend is recorded anyway — install data/build indexes and re-run \`openaqua doctor --probe\`.\n`,
          );
        } else {
          process.stdout.write(
            `probe failed (${summary}); the backend is recorded anyway — fix it and re-run \`openaqua doctor --probe\`.\n`,
          );
        }
      }
    } else {
      process.stdout.write(
        'openaqua backend: NOT FOUND — research tools will report guidance until you set OPENAQUA_REPO, run `openaqua onboard --openaqua-repo /path/to/OpenAqua`, or provide an adapter-compatible OPENAQUA_COMMAND.\n',
      );
    }

    const mcpJson = ensureOpenAquaMcpJson(homeDir);
    process.stdout.write(`mcp.json: openaqua server registered (${mcpJson})\n`);

    const harness = createOpenAquaHarness(homeDir);
    try {
      await ensureOpenAquaSkillDirs(harness);
    } finally {
      await harness.close();
    }
    process.stdout.write('skills: OpenAqua operation and campaign skills registered\n');
    restrictOpenAquaHomePermissions(homeDir);

    process.stdout.write(
      ['', 'Done. Next:', '  openaqua doctor --probe', '  openaqua chat', '  openaqua web', ''].join('\n'),
    );
  } finally {
    rl?.close();
  }
}

async function readDefaultModel(homeDir: string): Promise<string | undefined> {
  const harness = createOpenAquaHarness(homeDir);
  try {
    return (await harness.getConfig()).defaultModel;
  } finally {
    await harness.close();
  }
}

async function setupModel(homeDir: string, options: OnboardOptions, rl: Interface | undefined): Promise<void> {
  const existing = await readDefaultModel(homeDir);
  if (existing !== undefined && options.provider === undefined) {
    process.stdout.write(`default model: ${existing} (already configured — no login required)\n`);
    return;
  }

  if (options.provider !== undefined) {
    await applyProviderFlag(homeDir, options);
    return;
  }

  if (rl !== undefined) {
    const choice = await ask(
      rl,
      [
        'No default model configured. Choose how to set one up:',
        ...PROVIDER_PRESETS.map((p, i) => `  ${i + 1}) ${p.label} — ${p.hint}`),
        `  ${PROVIDER_PRESETS.length + 1}) custom OpenAI/Anthropic-compatible endpoint`,
        `  ${PROVIDER_PRESETS.length + 2}) skip (configure later)`,
        'choice',
      ].join('\n'),
      '1',
    );
    const idx = Number.parseInt(choice, 10);
    if (idx >= 1 && idx <= PROVIDER_PRESETS.length) {
      const preset = PROVIDER_PRESETS[idx - 1]!;
      const keyMode = await ask(
        rl,
        'API key source: 1) environment variable (recommended)  2) paste into config.toml',
        '1',
      );
      const useEnvironment = keyMode !== '2';
      const apiKeyEnv = useEnvironment
        ? await ask(rl, 'env var name holding the key', defaultEnvName(preset.id))
        : undefined;
      const apiKey = useEnvironment
        ? undefined
        : await ask(rl, `${preset.label} API key (input is visible and stored plaintext)`, '');
      await applyAndReport(homeDir, { presetId: preset.id, apiKey, apiKeyEnv });
    } else if (idx === PROVIDER_PRESETS.length + 1) {
      const baseUrl = await ask(rl, 'base URL (e.g. https://host/v1)', '');
      const providerType = (await ask(rl, 'provider type (openai|anthropic|kimi)', 'openai')) as OnboardOptions['providerType'];
      const model = await ask(rl, 'model name (required — the default model follows the provider)', '');
      if (baseUrl === '' || model === '') {
        process.stdout.write('base URL and model name are required for a custom provider — skipped.\n');
      } else {
        const apiKeyEnv = await ask(
          rl,
          'API key env var (recommended; enter "none" for an endpoint without authentication)',
          'CUSTOM_API_KEY',
        );
        await applyAndReport(homeDir, {
          presetId: 'custom',
          providerType,
          baseUrl,
          model,
          apiKeyEnv: apiKeyEnv.toLowerCase() === 'none' ? undefined : apiKeyEnv,
        });
      }
    } else {
      process.stdout.write('skipped model setup.\n');
    }
    return;
  }

  process.stdout.write(
    [
      'no default model configured. Set one without login; environment-variable keys are recommended:',
      '  export DEEPSEEK_API_KEY="..."',
      '  openaqua onboard --provider deepseek --api-key-env DEEPSEEK_API_KEY',
      '  export KIMI_CODING_API_KEY="..."',
      '  openaqua onboard --provider kimi-coding --api-key-env KIMI_CODING_API_KEY',
      '  openaqua onboard --provider custom --base-url https://host/v1 --model my-model --api-key-env LAB_API_KEY',
      '',
    ].join('\n'),
  );
}

function defaultEnvName(presetId: string): string {
  return `${presetId.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

async function applyProviderFlag(homeDir: string, options: OnboardOptions): Promise<void> {
  await applyAndReport(homeDir, {
    presetId: options.provider,
    providerName: undefined,
    providerType: options.providerType,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
    model: options.model,
  });
}

async function applyAndReport(
  homeDir: string,
  options: Parameters<typeof applyApiProvider>[1],
): Promise<void> {
  const harness = createOpenAquaHarness(homeDir);
  try {
    const applied = await applyApiProvider(harness, options);
    process.stdout.write(
      `provider: ${applied.providerName} configured (models: ${applied.aliases.join(', ')})\n`,
    );
    if (applied.defaultAlias !== undefined) {
      process.stdout.write(`default model: ${applied.defaultAlias} — works without any login\n`);
    }
  } finally {
    await harness.close();
  }
}

async function maybeImportCredentials(
  homeDir: string,
  importFrom: string | undefined,
  rl: Interface | undefined,
): Promise<boolean> {
  const candidates = [
    importFrom,
    ...(rl === undefined ? [] : [process.env['KIMI_CODE_HOME']]),
  ]
    .filter((candidate): candidate is string => candidate !== undefined)
    .map((candidate) => resolveUserPath(candidate))
    .filter((candidate) => candidate !== path.resolve(homeDir));
  for (const candidate of candidates) {
    if (!existsSync(path.join(candidate, 'config.toml'))) continue;
    const answer =
      rl === undefined
        ? 'y'
        : await ask(rl, `Import config + credentials from ${candidate}?`, 'y');
    if (!answer.toLowerCase().startsWith('y')) continue;
    copyKimiHome(candidate, homeDir);
    process.stdout.write(`imported config + credentials from ${candidate}\n`);
    return true;
  }
  return false;
}

function copyKimiHome(from: string, to: string): void {
  for (const entry of IMPORT_FILES) {
    const src = path.join(from, entry);
    const dst = path.join(to, entry);
    if (!existsSync(src) || existsSync(dst)) continue;
    if (!isSafeImportTree(src)) {
      process.stderr.write(
        `warning: skipped ${entry} because its import tree contains a symbolic link or unreadable entry\n`,
      );
      continue;
    }
    cpSync(src, dst, { recursive: true, filter: isSafeImportEntry });
    restrictImportedPermissions(dst);
  }
}

function isSafeImportTree(filePath: string): boolean {
  try {
    const metadata = lstatSync(filePath);
    if (metadata.isSymbolicLink()) return false;
    return !metadata.isDirectory() || readdirSync(filePath).every((entry) =>
      isSafeImportTree(path.join(filePath, entry)),
    );
  } catch {
    return false;
  }
}

function isSafeImportEntry(filePath: string): boolean {
  try {
    return !lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function restrictImportedPermissions(filePath: string): void {
  const metadata = lstatSync(filePath);
  if (metadata.isDirectory()) {
    chmodSync(filePath, 0o700);
    for (const entry of readdirSync(filePath)) {
      restrictImportedPermissions(path.join(filePath, entry));
    }
  } else if (metadata.isFile()) {
    chmodSync(filePath, 0o600);
  }
}

function restrictOpenAquaHomePermissions(homeDir: string): void {
  if (process.platform === 'win32') return;
  chmodSync(homeDir, 0o700);
  for (const entry of [
    'config.toml',
    'mcp.json',
    'openaqua.json',
    'credentials',
    'oauth',
    'tui.toml',
  ]) {
    const filePath = path.join(homeDir, entry);
    if (existsSync(filePath)) restrictImportedPermissions(filePath);
  }
}

async function pickBackend(
  homeDir: string,
  options: OnboardOptions,
  rl: Interface | undefined,
): Promise<OpenAquaBackend | undefined> {
  if (options.openaquaCommand !== undefined) {
    const command = parseCommand(options.openaquaCommand);
    if (command === undefined) throw new Error('--openaqua-command cannot be empty');
    atomicWriteJson(path.join(homeDir, 'openaqua.json'), { command });
    return { command, source: 'cli flag' };
  }
  if (options.openaquaRepo !== undefined) {
    const repo = resolveUserPath(options.openaquaRepo);
    const command = repoCommand(repo);
    if (command === undefined) {
      throw new Error(
        `--openaqua-repo is not a usable OpenAqua checkout or no Python interpreter is available: ${repo}`,
      );
    }
    atomicWriteJson(path.join(homeDir, 'openaqua.json'), { repo });
    return { command, source: `repo:${repo}` };
  }
  const existing = resolveOpenAquaBackend(process.env, homeDir);
  if (existing !== undefined) return existing;

  const repoCandidates = uniquePaths([
    process.env['OPENAQUA_REPO'],
    process.cwd(),
    path.join(process.cwd(), '..', 'OpenAqua'),
    path.join(homedir(), 'OpenAqua'),
    path.join(homedir(), 'Desktop', 'OpenAqua'),
    path.join(homedir(), 'Documents', 'OpenAqua'),
  ]).filter((repo) => repoCommand(repo) !== undefined);
  for (const repo of repoCandidates) {
    const command = repoCommand(repo);
    if (command === undefined) continue;
    const use = await ask(
      rl,
      `OpenAqua repo found at ${repo}. Use it via \`${command.join(' ')}\`?`,
      'y',
    );
    if (use.toLowerCase().startsWith('y')) {
      atomicWriteJson(path.join(homeDir, 'openaqua.json'), { repo });
      return { command, source: `repo:${repo}` };
    }
  }
  return undefined;
}

async function ask(rl: Interface | undefined, question: string, fallback = ''): Promise<string> {
  if (rl === undefined) return fallback;
  const suffix = fallback === '' ? ': ' : ` [${fallback}]: `;
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}`, (answer) => {
      resolve(answer.trim() !== '' ? answer.trim() : fallback);
    });
  });
}

function uniquePaths(candidates: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(
      candidates
        .filter((candidate): candidate is string => candidate !== undefined && candidate.trim() !== '')
        .map((candidate) => resolveUserPath(candidate)),
    ),
  ];
}
