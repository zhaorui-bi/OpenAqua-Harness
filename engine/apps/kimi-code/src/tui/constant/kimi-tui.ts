import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { INTERACTIVE_HOST } from '#/constant/interactive-host';

export { DEFAULT_OAUTH_PROVIDER_NAME, OAUTH_LOGIN_REQUIRED_CODE, PRODUCT_NAME } from '#/constant/app';

export const LLM_NOT_SET_MESSAGE =
  INTERACTIVE_HOST.id === 'openaqua-harness'
    ? 'No model configured. Run /provider to add a provider and select a model.'
    : 'LLM not set, send "/login" to login';
export const NO_ACTIVE_SESSION_MESSAGE = 'No active session. Send a message to start one.';
export const CTRL_D_HINT = 'Press Ctrl+D again to exit';
export const CTRL_C_HINT = 'Press Ctrl+C again to exit';
export const SHUTTING_DOWN_HINT = 'Shutting down… (running shutdown hooks)';
export const MAIN_AGENT_ID = 'main';
export const OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE =
  INTERACTIVE_HOST.id === 'openaqua-harness'
    ? 'Model credentials are unavailable. Run /provider to review the API provider configuration.'
    : 'OAuth login expired. Send /login to login.';
export const TUI_MODE_RESTART_NOTICE = `TUI mode takes effect after restarting ${INTERACTIVE_HOST.productName}.`;
export const SESSIONLESS_STARTUP_NOTICE =
  INTERACTIVE_HOST.id === 'openaqua-harness'
    ? 'Water-treatment research workspace ready — a session will start with your first message.'
    : 'No session yet — one will be created on your first message.';
export const TOWER_TEARDOWN_PROMPT =
  'Tear down the tower: call TowerTeardown and report what it did. It refuses to destroy dirty worktrees unless forced.';
export const EXIT_CONFIRM_WINDOW_MS = 1500;
// Time window for treating two consecutive Esc presses as a double-Esc, which
// opens the undo selector. Kept short (double-click feel) so two deliberate
// presses far apart don't accidentally trigger undo.
export const DOUBLE_ESC_WINDOW_MS = 600;

/** Session picker page size: one backend keyset page and one picker window. */
export const SESSION_LIST_PAGE_SIZE = 50;

export function isManagedUsageProvider(
  providerKey: string | undefined,
): providerKey is typeof DEFAULT_OAUTH_PROVIDER_NAME {
  return providerKey === DEFAULT_OAUTH_PROVIDER_NAME;
}
