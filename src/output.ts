import type { DenySet } from './deny-set.js'
import { DeniedContentError, redactText } from './scrub.js'

// Last line of defence before stdout. Walks the finished output and
// refuses to print it if any denied id or redact term is still present.

/** Fields that hold message ids or counts, never peer ids. */
const COUNTER_KEYS = new Set([
  'id',
  'topMessageId',
  'lastReadInboxMaxId',
  'replyToId',
  'unreadCount',
  'unreadMentions',
  'messageId',
  'maxId',
  'sendsToday',
  'dailySendCap',
  'workInvitesToday',
  'invitationsToday',
  'dailyWorkInviteCap',
  'dailyCap',
])

/** Redacts denied ids and terms in every string of a value. */
export function redactStrings<T>(value: T, deny: DenySet): T {
  if (typeof value === 'string') return redactText(value, deny) as T
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, deny)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactStrings(v, deny)
    return out as T
  }
  return value
}

export function assertClean(value: unknown, deny: DenySet): void {
  const ids = new Set(deny.idStrings().map((s) => s.replace(/^-/, '')))
  const idToken = /\d+/g
  const checkString = (s: string): void => {
    const digits = s.match(idToken)
    if (digits) for (const d of digits) if (ids.has(d)) throw new DeniedContentError()
    if (deny.matchesTerm(s)) throw new DeniedContentError()
  }
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === 'string') return checkString(v)
    if (typeof v === 'number') {
      // Cursor entries map a chat id to a message id.
      if (key !== null && (COUNTER_KEYS.has(key) || /^-?\d+$/.test(key))) return
      if (ids.has(String(Math.abs(v)))) throw new DeniedContentError()
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, key)
      return
    }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        checkString(k)
        walk(child, k)
      }
    }
  }
  walk(value, null)
}
