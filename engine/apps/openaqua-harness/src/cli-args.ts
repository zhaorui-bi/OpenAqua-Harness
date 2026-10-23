import { parseArgs } from 'node:util';

export const PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export type CliInvocation =
  | { readonly kind: 'tui' }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'run'; readonly prompt: string }
  | { readonly kind: 'chat' }
  | {
      readonly kind: 'web';
      readonly host?: string;
      readonly port?: number;
      readonly noOpen: boolean;
      readonly homeDir?: string;
    }
  | {
      readonly kind: 'doctor';
      readonly json: boolean;
      readonly probe: boolean;
      readonly homeDir?: string;
    }
  | {
      readonly kind: 'onboard';
      readonly yes: boolean;
      readonly homeDir?: string;
      readonly openaquaCommand?: string;
      readonly openaquaRepo?: string;
      readonly importFrom?: string;
      readonly provider?: string;
      readonly apiKey?: string;
      readonly apiKeyEnv?: string;
      readonly model?: string;
      readonly baseUrl?: string;
      readonly providerType?: ProviderType;
    }
  | { readonly kind: 'tools'; readonly json: boolean; readonly homeDir?: string }
  | { readonly kind: 'info'; readonly homeDir?: string };

export class CliArgumentError extends Error {
  override readonly name = 'CliArgumentError';
}

type OptionDefinition = {
  readonly type: 'boolean' | 'string';
  readonly short?: string;
};

type ParsedOptions = {
  readonly values: Record<string, string | boolean | undefined>;
  readonly positionals: readonly string[];
};

const HELP_OPTION = { type: 'boolean', short: 'h' } as const;

export function parseCliInvocation(argv: readonly string[]): CliInvocation {
  const [command, ...args] = argv;
  if (command === undefined) return { kind: 'tui' };
  if (command === '--help' || command === '-h' || command === 'help') {
    assertNoArguments(args, command);
    return { kind: 'help' };
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    assertNoArguments(args, command);
    return { kind: 'version' };
  }

  switch (command) {
    case 'run': {
      const parsed = parseCommandArgs(args, { help: HELP_OPTION }, true);
      if (parsed.values['help'] === true) return { kind: 'help' };
      const prompt = parsed.positionals.join(' ').trim();
      if (prompt === '') throw new CliArgumentError('run requires a prompt');
      return { kind: 'run', prompt };
    }
    case 'chat': {
      const parsed = parseCommandArgs(args, { help: HELP_OPTION });
      if (parsed.values['help'] === true) return { kind: 'help' };
      return { kind: 'chat' };
    }
    case 'web': {
      const parsed = parseCommandArgs(args, {
        help: HELP_OPTION,
        host: { type: 'string' },
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        home: { type: 'string' },
      });
      if (parsed.values['help'] === true) return { kind: 'help' };
      return {
        kind: 'web',
        host: optionalNonEmptyString(parsed.values['host'], '--host'),
        port: optionalPort(parsed.values['port']),
        noOpen: parsed.values['no-open'] === true,
        homeDir: optionalNonEmptyString(parsed.values['home'], '--home'),
      };
    }
    case 'doctor': {
      const parsed = parseCommandArgs(args, {
        help: HELP_OPTION,
        json: { type: 'boolean' },
        probe: { type: 'boolean' },
        home: { type: 'string' },
      });
      if (parsed.values['help'] === true) return { kind: 'help' };
      return {
        kind: 'doctor',
        json: parsed.values['json'] === true,
        probe: parsed.values['probe'] === true,
        homeDir: optionalNonEmptyString(parsed.values['home'], '--home'),
      };
    }
    case 'onboard': {
      const parsed = parseCommandArgs(args, {
        help: HELP_OPTION,
        yes: { type: 'boolean' },
        home: { type: 'string' },
        'openaqua-command': { type: 'string' },
        'openaqua-repo': { type: 'string' },
        'import-from': { type: 'string' },
        provider: { type: 'string' },
        'api-key': { type: 'string' },
        'api-key-env': { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        'provider-type': { type: 'string' },
      });
      if (parsed.values['help'] === true) return { kind: 'help' };
      if (parsed.values['api-key'] !== undefined && parsed.values['api-key-env'] !== undefined) {
        throw new CliArgumentError('--api-key and --api-key-env cannot be used together');
      }
      if (
        parsed.values['openaqua-command'] !== undefined &&
        parsed.values['openaqua-repo'] !== undefined
      ) {
        throw new CliArgumentError('--openaqua-command and --openaqua-repo cannot be used together');
      }
      return {
        kind: 'onboard',
        yes: parsed.values['yes'] === true,
        homeDir: optionalNonEmptyString(parsed.values['home'], '--home'),
        openaquaCommand: optionalNonEmptyString(
          parsed.values['openaqua-command'],
          '--openaqua-command',
        ),
        openaquaRepo: optionalNonEmptyString(parsed.values['openaqua-repo'], '--openaqua-repo'),
        importFrom: optionalNonEmptyString(parsed.values['import-from'], '--import-from'),
        provider: optionalNonEmptyString(parsed.values['provider'], '--provider'),
        apiKey: optionalNonEmptyString(parsed.values['api-key'], '--api-key'),
        apiKeyEnv: optionalNonEmptyString(parsed.values['api-key-env'], '--api-key-env'),
        model: optionalNonEmptyString(parsed.values['model'], '--model'),
        baseUrl: optionalNonEmptyString(parsed.values['base-url'], '--base-url'),
        providerType: optionalProviderType(parsed.values['provider-type']),
      };
    }
    case 'tools': {
      const parsed = parseCommandArgs(args, {
        help: HELP_OPTION,
        json: { type: 'boolean' },
        home: { type: 'string' },
      });
      if (parsed.values['help'] === true) return { kind: 'help' };
      return {
        kind: 'tools',
        json: parsed.values['json'] === true,
        homeDir: optionalNonEmptyString(parsed.values['home'], '--home'),
      };
    }
    case 'info': {
      const parsed = parseCommandArgs(args, {
        help: HELP_OPTION,
        home: { type: 'string' },
      });
      if (parsed.values['help'] === true) return { kind: 'help' };
      return {
        kind: 'info',
        homeDir: optionalNonEmptyString(parsed.values['home'], '--home'),
      };
    }
    default:
      throw new CliArgumentError(`unknown command: ${command}`);
  }
}

function parseCommandArgs(
  args: readonly string[],
  options: Readonly<Record<string, OptionDefinition>>,
  allowPositionals = false,
): ParsedOptions {
  try {
    const parsed = parseArgs({
      args: [...args],
      options,
      allowPositionals,
      strict: true,
    });
    return {
      values: parsed.values as Record<string, string | boolean | undefined>,
      positionals: parsed.positionals,
    };
  } catch (error) {
    throw new CliArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function assertNoArguments(args: readonly string[], command: string): void {
  if (args.length > 0) {
    throw new CliArgumentError(`${command} does not accept arguments`);
  }
}

function optionalNonEmptyString(
  value: string | boolean | undefined,
  flag: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliArgumentError(`${flag} requires a non-empty value`);
  }
  return value.trim();
}

function optionalPort(value: string | boolean | undefined): number | undefined {
  const raw = optionalNonEmptyString(value, '--port');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new CliArgumentError('--port must be an integer from 0 to 65535');
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new CliArgumentError('--port must be an integer from 0 to 65535');
  }
  return port;
}

function optionalProviderType(value: string | boolean | undefined): ProviderType | undefined {
  const raw = optionalNonEmptyString(value, '--provider-type');
  if (raw === undefined) return undefined;
  if (!PROVIDER_TYPES.some((type) => type === raw)) {
    throw new CliArgumentError(
      `--provider-type must be one of: ${PROVIDER_TYPES.join(', ')}`,
    );
  }
  return raw as ProviderType;
}
