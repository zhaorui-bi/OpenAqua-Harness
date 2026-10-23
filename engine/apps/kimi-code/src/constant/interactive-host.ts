export interface InteractiveHostBrand {
  readonly id: 'kimi-code' | 'openaqua-harness';
  readonly productName: string;
  readonly assistantName: string;
  readonly commandName: string;
  readonly processName: string;
  readonly logo: readonly [string, string];
  readonly welcomeArt?: readonly string[];
  readonly welcomeTagline?: string;
  readonly welcomeDescription?: string;
  readonly welcomeSpecialties?: string;
  readonly transcriptMarker: string;
  readonly promptSymbol: string;
  readonly promptLabel?: string;
  readonly modelSetupHint: string;
  readonly modelMissingHint: string;
  readonly showRemoteBanners: boolean;
  readonly hiddenCommands: readonly string[];
  readonly identity?: {
    readonly productName: string;
    readonly platform: string;
    readonly uiMode: string;
  };
  readonly version?: string;
}

const KIMI_CODE_BRAND: InteractiveHostBrand = {
  id: 'kimi-code',
  productName: 'Kimi Code',
  assistantName: 'Kimi',
  commandName: 'kimi',
  processName: 'kimi-code',
  logo: ['▐█▛█▛█▌', '▐█████▌'],
  transcriptMarker: '● ',
  promptSymbol: '>',
  modelSetupHint: 'Run /login or /provider to get started.',
  modelMissingHint: 'not set, run /login or /provider',
  showRemoteBanners: true,
  hiddenCommands: [],
};

function openAquaVersion(env: NodeJS.ProcessEnv): string | undefined {
  const value = env['OPENAQUA_VERSION']?.trim();
  if (value === undefined || value.length === 0 || value.length > 64) return undefined;
  return /^[0-9A-Za-z.+-]+$/.test(value) ? value : undefined;
}

export function resolveInteractiveHostBrand(
  env: NodeJS.ProcessEnv = process.env,
): InteractiveHostBrand {
  if (env['OPENAQUA_TUI'] !== '1') return KIMI_CODE_BRAND;
  return {
    id: 'openaqua-harness',
    productName: 'OpenAqua Harness',
    assistantName: 'OpenAqua',
    commandName: 'openaqua',
    processName: 'openaqua-harness',
    logo: ['<~AQUA~>', ' HARNESS'],
    welcomeArt: [
      '   ____                   ___',
      '  / __ \\____  ___  ____  /   | ____ ___  ______ _',
      ' / / / / __ \\/ _ \\/ __ \\/ /| |/ __ `/ / / / __ `/',
      '/ /_/ / /_/ /  __/ / / / ___ / /_/ / /_/ / /_/ /',
      '\\____/ .___/\\___/_/ /_/_/  |_\\__, /\\__,_/\\__,_/',
      '    /_/                       /_/',
      '       <====[ H A R N E S S ]====>',
    ],
    welcomeTagline: 'AGENTIC WATER-TREATMENT DESIGN',
    welcomeDescription: 'Evidence-grounded early-stage process-train workbench',
    welcomeSpecialties: 'PARSE  ::  RETRIEVE  ::  PLAN  ::  CRITIQUE  ::  EXPLAIN',
    transcriptMarker: '› ',
    promptSymbol: '›',
    promptLabel: 'WATER QUERY',
    modelSetupHint: 'Run /provider to configure a model.',
    modelMissingHint: 'not set, run /provider',
    showRemoteBanners: false,
    hiddenCommands: ['desktop', 'feedback', 'login', 'plugins', 'remote-control', 'web'],
    identity: {
      productName: 'openaqua-harness',
      platform: 'openaqua_harness',
      uiMode: 'openaqua-harness',
    },
    version: openAquaVersion(env),
  };
}

export const INTERACTIVE_HOST = resolveInteractiveHostBrand();

export function isInteractiveHostCommandEnabled(commandName: string): boolean {
  return !INTERACTIVE_HOST.hiddenCommands.includes(commandName);
}
