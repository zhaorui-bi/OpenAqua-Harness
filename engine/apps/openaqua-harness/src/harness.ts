import process from 'node:process';

import {
  createKimiHarness,
  type Event,
  type KimiHarness,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';

import { MCP_SERVER_NAME, mcpEnvironment, resolveMcpLaunch } from './mcp/register';
import { packageVersion, resolveOpenAquaHome, skillsDir } from './paths';

export { resolveOpenAquaHome } from './paths';

export const PRODUCT_NAME = 'openaqua-harness';

export function createOpenAquaHarness(homeDir: string = resolveOpenAquaHome()): KimiHarness {
  return createKimiHarness({
    homeDir,
    identity: {
      productName: PRODUCT_NAME,
      version: packageVersion(),
      platform: 'openaqua_harness',
    },
    uiMode: PRODUCT_NAME,
  });
}

export async function createDefaultSession(harness: KimiHarness): Promise<Session> {
  const config = await harness.getConfig();
  const model = config.defaultModel;
  if (model === undefined) {
    throw new Error('No model configured. Run `openaqua onboard` or set default_model in config.toml.');
  }
  return harness.createSession({ workDir: process.cwd(), model, permission: 'auto' });
}

export async function attachOpenAquaTools(session: Session, homeDir: string): Promise<void> {
  const launch = resolveMcpLaunch();
  await session.addMcpServer(
    {
      name: MCP_SERVER_NAME,
      transport: 'stdio',
      command: launch.command,
      args: [...launch.args],
      env: mcpEnvironment(homeDir),
    },
    { persist: false },
  );
}

export async function ensureOpenAquaSkillDirs(harness: KimiHarness): Promise<void> {
  const dir = skillsDir();
  const config = await harness.getConfig();
  const current = config.extraSkillDirs ?? [];
  if (current.includes(dir)) return;
  await harness.setConfig({ extraSkillDirs: [...current, dir] });
}

const TURN_TIMEOUT_MS = 1_800_000;

export async function promptTurnToEnd(session: Session, prompt: string): Promise<void> {
  let activeTurnId: number | undefined;
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const done = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for turn.ended'));
      void session.cancel().catch(() => undefined);
    }, TURN_TIMEOUT_MS);

    unsubscribe = session.onEvent((event: Event) => {
      if (event.type === 'turn.started') {
        activeTurnId = event.turnId;
        process.stderr.write(`[turn ${String(event.turnId)} started]\n`);
        return;
      }
      if (event.type === 'assistant.delta') {
        if (activeTurnId === undefined || event.turnId === activeTurnId) {
          process.stdout.write(event.delta);
        }
        return;
      }
      if (event.type === 'thinking.delta') {
        if (activeTurnId === undefined || event.turnId === activeTurnId) {
          process.stderr.write(event.delta);
        }
        return;
      }
      if (event.type === 'tool.call.started') {
        process.stderr.write(`[tool] ${event.name}\n`);
        return;
      }
      if (event.type === 'error') {
        reject(new Error(`${event.code}: ${event.message}`));
        return;
      }
      if (event.type === 'turn.ended') {
        if (activeTurnId === undefined || event.turnId === activeTurnId) {
          process.stdout.write(`\n[turn ${String(event.turnId)} ended: ${event.reason}]\n`);
          resolve();
        }
      }
    });
  });

  try {
    await Promise.all([session.prompt(prompt), done]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    unsubscribe?.();
  }
}
