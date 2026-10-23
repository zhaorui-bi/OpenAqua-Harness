import { isIP } from 'node:net';

import type { KimiHarness, ProviderConfig } from '@moonshot-ai/kimi-code-sdk';

export interface ProviderPresetModel {
  readonly alias: string;
  readonly model: string;
  readonly displayName: string;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly capabilities?: readonly string[];
}

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly providerName: string;
  readonly provider: Omit<ProviderConfig, 'apiKey' | 'apiKeyEnv'>;
  readonly models: readonly ProviderPresetModel[];
  readonly defaultAlias: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'kimi-coding',
    label: 'Kimi Coding Plan (API key)',
    hint: 'api.kimi.com coding plan, model kimi-for-coding',
    providerName: 'kimi-coding-api',
    provider: { type: 'kimi', baseUrl: 'https://api.kimi.com/coding/v1' },
    models: [
      {
        alias: 'kimi/kimi-for-coding',
        model: 'kimi-for-coding',
        displayName: 'Kimi for Coding (API)',
        maxContextSize: 262144,
        capabilities: ['thinking', 'always_thinking', 'image_in', 'tool_use'],
      },
      {
        alias: 'kimi/kimi-for-coding-highspeed',
        model: 'kimi-for-coding-highspeed',
        displayName: 'Kimi for Coding Highspeed (API)',
        maxContextSize: 262144,
        capabilities: ['thinking', 'always_thinking', 'image_in', 'tool_use'],
      },
    ],
    defaultAlias: 'kimi/kimi-for-coding',
  },
  {
    id: 'zai',
    label: 'Z.AI Coding Plan (zcode)',
    hint: 'api.z.ai coding plan, GLM models, OpenAI-compatible',
    providerName: 'zai-coding-api',
    provider: { type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    models: [
      {
        alias: 'zai/glm-4.6',
        model: 'glm-4.6',
        displayName: 'GLM 4.6 (Z.AI)',
        maxContextSize: 204800,
        maxOutputSize: 131072,
        capabilities: ['thinking', 'tool_use'],
      },
      {
        alias: 'zai/glm-4.5-air',
        model: 'glm-4.5-air',
        displayName: 'GLM 4.5 Air (Z.AI)',
        maxContextSize: 131072,
        maxOutputSize: 98304,
        capabilities: ['thinking', 'tool_use'],
      },
    ],
    defaultAlias: 'zai/glm-4.6',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: 'api.deepseek.com, OpenAI-compatible',
    providerName: 'deepseek-api',
    provider: { type: 'openai', baseUrl: 'https://api.deepseek.com' },
    models: [
      {
        alias: 'deepseek/deepseek-chat',
        model: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        maxContextSize: 131072,
        maxOutputSize: 8192,
        capabilities: ['tool_use'],
      },
      {
        alias: 'deepseek/deepseek-reasoner',
        model: 'deepseek-reasoner',
        displayName: 'DeepSeek Reasoner',
        maxContextSize: 131072,
        maxOutputSize: 65536,
        capabilities: ['thinking', 'tool_use'],
      },
    ],
    defaultAlias: 'deepseek/deepseek-chat',
  },
];

export interface ApiProviderOptions {
  readonly presetId?: string;
  readonly providerName?: string;
  readonly providerType?: ProviderConfig['type'];
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly model?: string;
  readonly setDefault?: boolean;
}

export interface AppliedProvider {
  readonly providerName: string;
  readonly defaultAlias?: string;
  readonly aliases: readonly string[];
}

export function resolvePreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export async function applyApiProvider(
  harness: KimiHarness,
  options: ApiProviderOptions,
): Promise<AppliedProvider> {
  validateCredentials(options);

  if (options.presetId !== undefined && options.presetId !== 'custom') {
    const preset = resolvePreset(options.presetId);
    if (preset === undefined) {
      throw new Error(`unknown provider preset: ${options.presetId}`);
    }
    const models = Object.fromEntries(
      preset.models.map((m) => [
        m.alias,
        {
          provider: preset.providerName,
          model: m.model,
          maxContextSize: m.maxContextSize,
          maxOutputSize: m.maxOutputSize,
          capabilities: m.capabilities === undefined ? undefined : [...m.capabilities],
          displayName: m.displayName,
        },
      ]),
    );
    const requestedModel = options.model;
    const defaultAlias =
      requestedModel === undefined
        ? preset.defaultAlias
        : preset.models.find(
            (candidate) => candidate.alias === requestedModel || candidate.model === requestedModel,
          )?.alias;
    if (defaultAlias === undefined || models[defaultAlias] === undefined) {
      throw new Error(
        `model ${String(requestedModel)} is not part of preset ${preset.id}; choose ${preset.models
          .map((model) => model.alias)
          .join(', ')}`,
      );
    }
    await harness.setConfig({
      providers: {
        [preset.providerName]: {
          ...preset.provider,
          apiKey: options.apiKey,
          apiKeyEnv: options.apiKeyEnv,
        },
      },
      models,
      defaultProvider: preset.providerName,
      defaultModel: options.setDefault === false ? undefined : defaultAlias,
    });
    return {
      providerName: preset.providerName,
      defaultAlias: options.setDefault === false ? undefined : defaultAlias,
      aliases: preset.models.map((m) => m.alias),
    };
  }

  const providerName = options.providerName?.trim() ?? 'custom-api';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(providerName)) {
    throw new Error('custom provider name may only contain letters, numbers, dot, underscore and hyphen');
  }
  const baseUrl = validateProviderBaseUrl(options.baseUrl);
  const model = options.model?.trim();
  if (model === undefined || model === '') {
    throw new Error(
      'custom provider requires --model NAME (the model id served by your endpoint; the default model follows the provider — nothing is hardcoded)',
    );
  }
  const providerType = options.providerType ?? 'openai';
  if (!PROVIDER_TYPE_VALUES.has(providerType)) {
    throw new Error(`unsupported provider type: ${providerType}`);
  }
  const alias = `${providerName}/${model}`;
  await harness.setConfig({
    providers: {
      [providerName]: {
        type: providerType,
        baseUrl,
        apiKey: options.apiKey,
        apiKeyEnv: options.apiKeyEnv,
      },
    },
    models: {
      [alias]: {
        provider: providerName,
        model,
        maxContextSize: 131072,
        displayName: `${providerName} ${model}`,
        capabilities: ['tool_use'],
      },
    },
    defaultProvider: providerName,
    defaultModel: options.setDefault === false ? undefined : alias,
  });
  return {
    providerName,
    defaultAlias: options.setDefault === false ? undefined : alias,
    aliases: [alias],
  };
}

const PROVIDER_TYPE_VALUES = new Set<ProviderConfig['type']>([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
]);

function validateCredentials(options: ApiProviderOptions): void {
  if (options.apiKey !== undefined && options.apiKeyEnv !== undefined) {
    throw new Error('apiKey and apiKeyEnv cannot both be configured');
  }
  if (options.apiKey !== undefined && options.apiKey.trim() === '') {
    throw new Error('API key cannot be empty');
  }
  if (
    options.apiKeyEnv !== undefined &&
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(options.apiKeyEnv)
  ) {
    throw new Error(`invalid API key environment variable name: ${options.apiKeyEnv}`);
  }
  if (
    options.presetId !== undefined &&
    options.presetId !== 'custom' &&
    options.apiKey === undefined &&
    options.apiKeyEnv === undefined
  ) {
    throw new Error(`provider ${options.presetId} requires --api-key or --api-key-env`);
  }
}

export function validateProviderBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error('custom provider requires --base-url');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid provider base URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('provider base URL must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('provider base URL must not contain embedded credentials');
  }
  const hostname = url.hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('non-loopback provider endpoints must use https to protect prompts and API keys');
  }
  return value.trim().replace(/\/+$/, '');
}
