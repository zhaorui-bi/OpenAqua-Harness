import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INTERACTIVE_HOST, resolveInteractiveHostBrand } from '#/constant/interactive-host';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\u001B\[38;2;(\d+);(\d+);(\d+)m/g;

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  stepRetry: null,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  towerMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

/** The two header rows (logo + title) of the rendered welcome box. */
function headerOf(lines: string[]): string {
  return [lines[3], lines[4]].join('\n');
}

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

describe('WelcomeComponent', () => {
  const previousChalkLevel = chalk.level;

  it('resolves an isolated OpenAqua presentation for the embedded host', () => {
    const brand = resolveInteractiveHostBrand({
      OPENAQUA_TUI: '1',
      OPENAQUA_VERSION: '0.2.0',
    });

    expect(brand).toMatchObject({
      id: 'openaqua-harness',
      productName: 'OpenAqua Harness',
      commandName: 'openaqua',
      logo: ['<~AQUA~>', ' HARNESS'],
      welcomeTagline: 'AGENTIC WATER-TREATMENT DESIGN',
      welcomeDescription: 'Evidence-grounded early-stage process-train workbench',
      transcriptMarker: '› ',
      promptSymbol: '›',
      promptLabel: 'WATER QUERY',
      showRemoteBanners: false,
      hiddenCommands: expect.arrayContaining(['desktop', 'login', 'remote-control']),
      version: '0.2.0',
    });
    expect(brand.welcomeArt).toHaveLength(7);
    expect(resolveInteractiveHostBrand({})).toMatchObject({
      id: 'kimi-code',
      productName: 'Kimi Code',
      commandName: 'kimi',
      logo: ['▐█▛█▛█▌', '▐█████▌'],
      transcriptMarker: '● ',
      promptSymbol: '>',
      showRemoteBanners: true,
      hiddenCommands: [],
    });
    expect(
      resolveInteractiveHostBrand({
        OPENAQUA_TUI: '1',
        OPENAQUA_VERSION: '<invalid>',
      }).version,
    ).toBeUndefined();
  });

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('renders the responsive OpenAqua water-treatment console', () => {
    const brand = resolveInteractiveHostBrand({
      OPENAQUA_TUI: '1',
      OPENAQUA_VERSION: '0.2.0',
    });
    const state = { ...appState, model: '', sessionId: '' };
    const wide = new WelcomeComponent(state, brand).render(120).join('\n');

    expect(wide).toContain('____');
    expect(wide).toContain('AGENTIC WATER-TREATMENT DESIGN');
    expect(wide).toContain('PARSE  ::  RETRIEVE  ::  PLAN  ::  CRITIQUE  ::  EXPLAIN');
    expect(wide).toContain('<====[ H A R N E S S ]====>');
    expect(wide).toContain('NOT CONFIGURED');
    expect(wide).toContain('Starts with your first message');
    expect(wide).toContain('/provider');

    for (const width of [24, 40, 64, 96, 120]) {
      for (const line of new WelcomeComponent(state, brand).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('renders the banner in a single brand color by default', () => {
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    // No rainbow by default — just the brand primary (plus the dim tagline).
    expect(codes.size).toBeLessThanOrEqual(2);
  });

  it('paints the banner in rainbow while colored', () => {
    setDanceView(true, 0);
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    if (INTERACTIVE_HOST.id === 'openaqua-harness') {
      expect(codes.size).toBeLessThanOrEqual(2);
    } else {
      expect(codes.size).toBeGreaterThanOrEqual(5);
    }
  });

  it('renders exactly the default banner when not colored', () => {
    const base = headerOf(new WelcomeComponent(appState).render(80));
    setDanceView(false, 5);
    const off = headerOf(new WelcomeComponent(appState).render(80));

    expect(off).toBe(base);
  });

  it('keeps every line within the requested width on narrow terminals', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
