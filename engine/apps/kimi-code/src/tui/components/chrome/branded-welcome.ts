import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import type { InteractiveHostBrand } from '#/constant/interactive-host';
import { currentTheme } from '#/tui/theme';
import type { AppState } from '#/tui/types';

const COMPACT_BINDING_MARK = [
  '     .---+---.     ',
  '<====|  BIND |====>',
  '     `---+---`     ',
] as const;

export interface BrandedWelcomeOptions {
  readonly state: AppState;
  readonly brand: InteractiveHostBrand;
  readonly width: number;
  readonly modelName: string;
  readonly modelConfigured: boolean;
}

function centered(line: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
  return `${' '.repeat(padding)}${line}`;
}

function field(label: string, value: string): string {
  return `${currentTheme.boldFg('textMuted', label.padEnd(11))}${value}`;
}

function framed(content: readonly string[], width: number, productName: string): string[] {
  const innerWidth = Math.max(1, width - 5);
  const pad = '  ';
  const rightPad = ' ';
  const label = ` ${productName.toUpperCase()} `;
  const canLabelBorder = visibleWidth(label) <= width - 6;
  const top = canLabelBorder
    ? currentTheme.fg('primary', '╭─') +
      currentTheme.boldFg('accent', label) +
      currentTheme.fg('primary', `${'─'.repeat(width - visibleWidth(label) - 3)}╮`)
    : currentTheme.fg('primary', `╭${'─'.repeat(width - 2)}╮`);
  const empty =
    currentTheme.fg('primary', '│') +
    ' '.repeat(width - 2) +
    currentTheme.fg('primary', '│');
  const lines = ['', top, empty];

  for (const raw of content) {
    const line = truncateToWidth(raw, innerWidth, '…');
    const rightPadding = Math.max(0, innerWidth - visibleWidth(line));
    lines.push(
      currentTheme.fg('primary', '│') +
        pad +
        line +
        ' '.repeat(rightPadding) +
        rightPad +
        currentTheme.fg('primary', '│'),
    );
  }

  lines.push(empty);
  lines.push(currentTheme.fg('primary', `╰${'─'.repeat(width - 2)}╯`));
  lines.push('');
  return lines.map((line) => truncateToWidth(line, width, '…'));
}

export function renderBrandedWelcome(options: BrandedWelcomeOptions): string[] {
  const { state, brand, width, modelName, modelConfigured } = options;
  const innerWidth = Math.max(1, width - 5);
  const art = brand.welcomeArt ?? brand.logo;
  const artWidth = Math.max(...art.map((row) => visibleWidth(row)));
  const tagline = brand.welcomeTagline ?? brand.productName.toUpperCase();
  const description = brand.welcomeDescription ?? '';
  const specialties = brand.welcomeSpecialties ?? '';
  const model = modelConfigured
    ? currentTheme.fg('textStrong', modelName)
    : currentTheme.boldFg('warning', 'NOT CONFIGURED');
  const session =
    state.sessionId.trim().length > 0
      ? currentTheme.fg('text', state.sessionId)
      : currentTheme.fg('textDim', 'Starts with your first message');
  const divider = currentTheme.fg('border', ` ${'─'.repeat(Math.max(1, innerWidth - 2))}`);
  const quickStart =
    field('NEXT', currentTheme.boldFg('primary', '/provider')) +
    (innerWidth < 52
      ? currentTheme.fg('textDim', ' setup  ::  ') +
        currentTheme.boldFg('primary', '/help')
      : currentTheme.fg('textDim', ' model setup  ::  ') +
        currentTheme.boldFg('primary', '/help') +
        currentTheme.fg('textDim', ' commands'));
  const content: string[] = [];

  if (innerWidth >= artWidth + 39) {
    const gap = '    ';
    const rightWidth = innerWidth - artWidth - gap.length;
    const specialtyParts = specialties.split('  ::  ');
    const specialtyRows =
      visibleWidth(specialties) <= rightWidth || specialtyParts.length < 3
        ? [specialties, '']
        : [
            specialtyParts.slice(0, 2).join('  ::  '),
            specialtyParts.slice(2).join('  ::  '),
          ];
    const right = [
      currentTheme.boldFg('accent', tagline),
      currentTheme.fg('textStrong', description),
      ...specialtyRows.map((row) => currentTheme.fg('textDim', row)),
      field('MODEL', model),
      field('VERSION', currentTheme.fg('text', state.version)),
    ];
    for (let index = 0; index < art.length; index++) {
      const artLine = art[index] ?? '';
      const styledArt =
        index === art.length - 1
          ? currentTheme.boldFg('accent', artLine.padEnd(artWidth))
          : currentTheme.fg('primary', artLine.padEnd(artWidth));
      content.push(
        styledArt + gap + truncateToWidth(right[index] ?? '', rightWidth, '…'),
      );
    }
    content.push('', divider);
  } else if (innerWidth >= artWidth) {
    const artPadding = ' '.repeat(Math.max(0, Math.floor((innerWidth - artWidth) / 2)));
    for (let index = 0; index < art.length; index++) {
      const artLine = art[index] ?? '';
      content.push(
        artPadding +
          (index === art.length - 1
            ? currentTheme.boldFg('accent', artLine)
            : currentTheme.fg('primary', artLine)),
      );
    }
    content.push(
      '',
      centered(currentTheme.boldFg('accent', tagline), innerWidth),
      centered(currentTheme.fg('textDim', specialties), innerWidth),
      divider,
      field('MODEL', model),
      field('VERSION', currentTheme.fg('text', state.version)),
    );
  } else {
    for (const row of COMPACT_BINDING_MARK) {
      content.push(centered(currentTheme.fg('primary', row), innerWidth));
    }
    content.push(
      centered(currentTheme.boldFg('accent', brand.productName.toUpperCase()), innerWidth),
      centered(currentTheme.fg('textDim', tagline), innerWidth),
      divider,
      field('MODEL', model),
      field('VERSION', currentTheme.fg('text', state.version)),
    );
  }

  content.push(
    field('WORKSPACE', currentTheme.fg('text', state.workDir)),
    field('SESSION', session),
  );
  if (state.mcpServersSummary) {
    content.push(field('TOOLS', currentTheme.fg('success', state.mcpServersSummary)));
  }
  content.push(quickStart);

  return framed(content, width, brand.productName);
}
