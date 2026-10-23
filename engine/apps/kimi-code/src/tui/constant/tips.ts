import {
  INTERACTIVE_HOST,
  isInteractiveHostCommandEnabled,
} from '#/constant/interactive-host';

export interface ToolbarTip {
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

/**
 * Subset of toolbar tips shown behind the composing spinner.
 */
export const WORKING_TIPS: readonly ToolbarTip[] = [
  ...(INTERACTIVE_HOST.id === 'openaqua-harness'
    ? [
        {
          text: 'start with source water, measured units, contaminants, effluent targets, and operating constraints',
          priority: 3,
          solo: true,
        },
        {
          text: 'run status, inspect the taxonomy, and validate one case before a larger WContBench evaluation',
          priority: 2,
          solo: true,
        },
        {
          text: 'treat recommendations as early-stage decision support; preserve evidence, assumptions, risks, and uncertainty',
          priority: 2,
          solo: true,
        },
      ]
    : [{ text: '/init: generate AGENTS.md', priority: 2 }]),
  {
    text: 'ctrl-s to add guidance without waiting for the turn to finish',
    priority: 2,
    solo: true,
  },
  { text: '/tasks to check progress and status for background tasks', priority: 2 },
  ...(isInteractiveHostCommandEnabled('plugins')
    ? [
        {
          text: '/plugins: manage plugins — try the "Kimi Datasource" for reliable financial, economic, and academic data',
          solo: true,
          priority: 3,
        },
      ]
    : []),
  {
    text: `ask ${INTERACTIVE_HOST.assistantName} to schedule tasks, e.g. "remind me at 5pm"`,
    solo: true,
    priority: 3,
  },
  { text: '/sessions to browse and resume earlier sessions', solo: true },
  { text: '/goal for multi-step work with a clear finish line', priority: 2, solo: true },
  { text: '/goal next to queue follow-up work while the current goal keeps running', solo: true },
  ...(isInteractiveHostCommandEnabled('web')
    ? [{ text: '/web: use the Web UI for a better experience', solo: true }]
    : []),
  { text: '@: mention files', priority: 2 },
  { text: '! to run a shell command', priority: 2 },
];

export const ALL_TIPS: readonly ToolbarTip[] = [
  ...WORKING_TIPS,
  { text: 'shift+enter: newline' },
  { text: 'ctrl+c: cancel' },
  { text: '/theme to switch the terminal UI theme' },
  {
    text: `/auto when you want ${INTERACTIVE_HOST.assistantName} to handle approvals and keep going unattended`,
  },
  { text: '/yolo to skip most approvals for trusted batch work, only use it in repos you trust' },
  { text: '/help: show commands' },
  { text: '/compact compresses context when it gets long', priority: 2 },
  { text: 'ctrl-o to hide or reveal tool output switching between a clean chat view and full execution details', priority: 2 },
  {
    text: `shift-tab to Plan mode to review the approach before ${INTERACTIVE_HOST.assistantName} edits files.`,
    priority: 2,
  },
  { text: '/model: switch model', priority: 2 },
];
