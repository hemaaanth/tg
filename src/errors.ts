// Every failure leaves the tool as one of these codes. Messages are fixed
// text, so no error can carry a name, a message or an id to the caller.

export type ErrorCode =
  | 'bad_args'
  | 'cooldown'
  | 'chat_unavailable'
  | 'method_blocked'
  | 'denied_content'
  | 'read_only'
  | 'send_disabled'
  | 'send_cap'
  | 'work_unset'
  | 'invite_disabled'
  | 'invite_cap'
  | 'too_soon'
  | 'budget'
  | 'not_logged_in'
  | 'config_invalid'
  | 'locked'
  | 'telegram_error'
  | 'internal'

const MESSAGES: Record<ErrorCode, string> = {
  bad_args: 'Invalid arguments.',
  cooldown: 'Telegram asked us to wait. Try again after the given time.',
  chat_unavailable: 'This chat is not available.',
  method_blocked: 'This Telegram method is not allowed.',
  denied_content: 'The response contained denied content and was withheld.',
  read_only: 'Writes are off (readOnly is set in the config).',
  send_disabled: 'Sending is off (allowSend is false in the config).',
  send_cap: 'The daily send cap is reached.',
  work_unset: 'Work-chat commands are off (workUser and workTitle are not set in the config).',
  invite_disabled: 'Work-user invitations are off (allowWorkInvite is false in the config).',
  invite_cap: 'The daily work-user invitation cap is reached.',
  too_soon: 'Too soon after the last call of this kind.',
  budget: 'The per-run call budget is used up.',
  not_logged_in: 'No Telegram session. An admin must log in first.',
  config_invalid: 'The tg config, denylist or state directory is missing or unsafe.',
  locked: 'Another tg process is running.',
  telegram_error: 'Telegram returned an error.',
  internal: 'Internal error.',
}

export const EXIT_CODES: Record<ErrorCode, number> = {
  bad_args: 2,
  cooldown: 3,
  chat_unavailable: 4,
  method_blocked: 4,
  denied_content: 4,
  read_only: 4,
  send_disabled: 4,
  send_cap: 4,
  work_unset: 4,
  invite_disabled: 4,
  invite_cap: 4,
  too_soon: 3,
  budget: 3,
  not_logged_in: 5,
  config_invalid: 5,
  locked: 1,
  telegram_error: 1,
  internal: 1,
}

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: { until?: string; rpc?: string } = {},
  ) {
    super(MESSAGES[code])
  }
}

/** RPC error names are fixed Telegram strings like "PEER_ID_INVALID". */
export function safeRpcName(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  return /^[A-Z0-9_%]{3,64}$/.test(text) ? text : undefined
}

export function errorPayload(err: ToolError): { code: ErrorCode; message: string; until?: string; rpc?: string } {
  return { code: err.code, message: MESSAGES[err.code], ...err.extra }
}
