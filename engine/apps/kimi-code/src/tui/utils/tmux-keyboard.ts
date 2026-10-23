import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { INTERACTIVE_HOST } from '#/constant/interactive-host';

const TMUX_QUERY_TIMEOUT_MS = 2000;

export const TMUX_EXTENDED_KEYS_OFF_WARNING =
  'tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.';

export const TMUX_EXTENDED_KEYS_FORMAT_XTERM_WARNING =
  `tmux extended-keys-format is xterm. ${INTERACTIVE_HOST.productName} works best with csi-u. Add \`set -g extended-keys-format csi-u\` to ~/.tmux.conf and restart tmux.`;

export type TmuxOptionReader = (option: string) => Promise<string | undefined>;

export async function detectTmuxKeyboardWarning(
  env: NodeJS.ProcessEnv = process.env,
  readTmuxOption: TmuxOptionReader = readTmuxOptionFromProcess,
): Promise<string | undefined> {
  if ((env['TMUX'] ?? '').length === 0) return undefined;

  const [extendedKeys, extendedKeysFormat] = await Promise.all([
    readTmuxOption('extended-keys'),
    readTmuxOption('extended-keys-format'),
  ]);

  if (extendedKeys === undefined) return undefined;

  if (extendedKeys !== 'on' && extendedKeys !== 'always') {
    return TMUX_EXTENDED_KEYS_OFF_WARNING;
  }

  if (extendedKeysFormat === 'xterm') {
    return TMUX_EXTENDED_KEYS_FORMAT_XTERM_WARNING;
  }

  return undefined;
}

async function readTmuxOptionFromProcess(option: string): Promise<string | undefined> {
  const proc = spawn('tmux', ['show', '-gv', option], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  proc.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString('utf8');
  });

  const timedOut = Symbol('tmux-query-timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      once(proc, 'close').then(([code]) => code as number | null),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => {
          resolve(timedOut);
        }, TMUX_QUERY_TIMEOUT_MS);
      }),
    ]);
    if (result === timedOut) {
      proc.kill();
      return undefined;
    }
    return result === 0 ? stdout.trim() : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
