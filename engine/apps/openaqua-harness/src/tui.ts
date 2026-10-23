import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  createOpenAquaHarness,
  ensureOpenAquaSkillDirs,
  resolveOpenAquaHome,
} from './harness';
import { ensureOpenAquaMcpJson } from './mcp/register';
import { monorepoRoot, packageVersion, resolveUserPath } from './paths';

export function resolveTuiEntry(): string | undefined {
  const bundled = path.join(monorepoRoot(), 'apps', 'kimi-code', 'dist', 'main.mjs');
  return existsSync(bundled) ? bundled : undefined;
}

export function openAquaTuiEnvironment(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    KIMI_CODE_HOME: homeDir,
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    KIMI_DISABLE_TELEMETRY: '1',
    OPENAQUA_HOME: homeDir,
    OPENAQUA_TUI: '1',
    OPENAQUA_VERSION: packageVersion(),
  };
}

export async function launchTui(homeDir: string = resolveOpenAquaHome()): Promise<number> {
  const resolvedHomeDir = resolveUserPath(homeDir);
  const entry = resolveTuiEntry();
  if (entry === undefined) return -1;

  ensureOpenAquaMcpJson(resolvedHomeDir);
  const harness = createOpenAquaHarness(resolvedHomeDir);
  try {
    await ensureOpenAquaSkillDirs(harness);
  } finally {
    await harness.close();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const child = spawn(process.execPath, [entry], {
      stdio: 'inherit',
      env: openAquaTuiEnvironment(resolvedHomeDir),
    });
    child.once('close', (code) => {
      finish(code ?? 0);
    });
    child.once('error', () => {
      finish(1);
    });
  });
}
