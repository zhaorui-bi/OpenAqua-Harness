import { INTERACTIVE_HOST } from '#/constant/interactive-host';

// The upstream host keeps its solid status dot. OpenAqua uses a lighter
// chevron so transcript sections do not read as a column of heavy circles.
export const STATUS_BULLET = INTERACTIVE_HOST.transcriptMarker;

// Shared transcript markers. Keep widths stable because message wrapping
// assumes the marker occupies the leading cells.
export const USER_MESSAGE_BULLET = '❯ ';
export const SUCCESS_MARK = '✓ ';
export const FAILURE_MARK = '✗ ';

// Shared selector markers — keep every list picker visually consistent.
// SELECT_POINTER marks the highlighted row; CURRENT_MARK is appended to the
// row that is the currently-active value. See .agents/skills/write-tui/DESIGN.md.
export const SELECT_POINTER = '❯';
export const CURRENT_MARK = '← current';
