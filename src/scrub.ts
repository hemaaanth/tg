import { Long } from '@mtcute/core'
import type { DenySet } from './deny-set.js'
import { markedFromChatObject, markedFromPeer } from './ids.js'

// Response filtering. This runs inside the RPC middleware, so it sees every
// response before mtcute's peer cache and session storage do.
//
// Two passes:
//   discover() — reads the raw response and adds groups to the deny set
//                when it proves a denied user is a member.
//   scrub()    — builds a new object without any denied peer in it.

/** Keys whose numeric value is a user id. */
const USER_KEYS = new Set([
  'userId',
  'inviterId',
  'adminId',
  'kickedBy',
  'promotedBy',
  'viaBotId',
  'viaBusinessBotId',
  'botId',
])
/** Keys whose value is an array of user ids. */
const USER_ARRAY_KEYS = new Set(['users', 'userIds'])
/** Keys whose numeric value is a raw basic-group id. */
const CHAT_KEYS = new Set(['chatId', 'migratedFromChatId'])
/** Keys whose numeric value is a raw channel id. */
const CHANNEL_KEYS = new Set(['channelId', 'linkedChatId'])

/** Message fields we keep. Everything else is dropped before caching. */
const MESSAGE_KEEP = new Set([
  '_',
  'id',
  'out',
  'mentioned',
  'post',
  'fromId',
  'peerId',
  'savedPeerId',
  'fwdFrom',
  'viaBotId',
  'viaBusinessBotId',
  'replyTo',
  'date',
  'message',
  'media',
  'editDate',
  'postAuthor',
  'action',
  'groupedId',
])
const REPLY_KEEP = new Set(['_', 'replyToMsgId', 'replyToPeerId', 'replyFrom', 'replyToTopId', 'forumTopic'])

export const HIDDEN = '[hidden]'

const DROP: unique symbol = Symbol('drop')
type Scrubbed = unknown | typeof DROP

export class DeniedContentError extends Error {
  constructor() {
    super('denied_content')
  }
}

function isOpaque(v: object): boolean {
  return ArrayBuffer.isView(v) || v instanceof ArrayBuffer || Long.isLong(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isOpaque(v)
}

function isMessage(v: Record<string, unknown>): boolean {
  return v._ === 'message' || v._ === 'messageService'
}

// ─── discovery ────────────────────────────────────────────────────────────

function deniedPeer(peer: unknown, deny: DenySet): boolean {
  const marked = markedFromPeer(peer)
  return marked !== null && deny.isMarked(marked)
}

function actionNamesDenied(action: unknown, deny: DenySet): boolean {
  if (!isRecord(action)) return false
  for (const [k, v] of Object.entries(action)) {
    if (USER_KEYS.has(k) && typeof v === 'number' && deny.isUser(v)) return true
    if (USER_ARRAY_KEYS.has(k) && Array.isArray(v) && v.some((x) => typeof x === 'number' && deny.isUser(x))) {
      return true
    }
  }
  return false
}

/** True when this group message proves a denied user is in the group. */
function provesDeniedMember(msg: Record<string, unknown>, deny: DenySet): boolean {
  if (deniedPeer(msg.fromId, deny)) return true
  if (msg._ === 'messageService' && actionNamesDenied(msg.action, deny)) return true
  const reactions = msg.reactions
  if (isRecord(reactions)) {
    for (const list of [reactions.recentReactions, reactions.topReactors]) {
      if (Array.isArray(list) && list.some((r) => isRecord(r) && deniedPeer(r.peerId, deny))) return true
    }
  }
  const replies = msg.replies
  if (isRecord(replies) && Array.isArray(replies.recentRepliers)) {
    if (replies.recentRepliers.some((p) => deniedPeer(p, deny))) return true
  }
  return false
}

/**
 * Walks a raw response. Adds a group to the deny set when a message in it
 * comes from, names, or carries a reaction or reply by a denied user.
 */
export function discover(value: unknown, deny: DenySet): void {
  const seen = new Set<object>()
  const walk = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || isOpaque(v) || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    const obj = v as Record<string, unknown>
    if (isMessage(obj)) {
      const chat = markedFromPeer(obj.peerId)
      if (chat !== null && chat < 0 && provesDeniedMember(obj, deny)) deny.addChat(chat)
    }
    for (const child of Object.values(obj)) walk(child)
  }
  walk(value)
}

// ─── text redaction ──────────────────────────────────────────────────────

const patternCache = new WeakMap<DenySet, { size: number; re: RegExp | null }>()

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactPattern(deny: DenySet): RegExp | null {
  // The deny set grows during a run, so the cache is keyed by its size.
  const size = deny.users.size + deny.chats.size
  const cached = patternCache.get(deny)
  if (cached && cached.size === size) return cached.re
  const parts: string[] = []
  for (const t of deny.terms) parts.push(escapeRe(t))
  const ids = deny.idStrings().map((s) => s.replace(/^-/, ''))
  if (ids.length) parts.push(`(?<!\\d)(?:${ids.map(escapeRe).join('|')})(?!\\d)`)
  const re = parts.length ? new RegExp(parts.join('|'), 'gi') : null
  patternCache.set(deny, { size, re })
  return re
}

/** Replaces denied ids and redact terms in free text. */
export function redactText(text: string, deny: DenySet): string {
  const re = redactPattern(deny)
  if (!re || !text) return text
  re.lastIndex = 0
  return text.replace(re, HIDDEN)
}

const USER_LINK = /(?:tg:\/\/user\?id=|openmessage\?user_id=|tg:\/\/openmessage\?user_id=)(\d+)/i

/** Replaces the text covered by mentions of denied users. */
function redactMentions(text: string, entities: unknown, deny: DenySet): string {
  if (!Array.isArray(entities) || !text) return text
  const spans: Array<[number, number]> = []
  for (const e of entities) {
    if (!isRecord(e) || typeof e.offset !== 'number' || typeof e.length !== 'number') continue
    let hit = false
    if ((e._ === 'messageEntityMentionName' || e._ === 'inputMessageEntityMentionName') && typeof e.userId === 'number') {
      hit = deny.isUser(e.userId)
    } else if (e._ === 'messageEntityTextUrl' && typeof e.url === 'string') {
      const m = USER_LINK.exec(e.url)
      hit = m !== null && deny.isUser(Number(m[1]))
    }
    if (hit) spans.push([e.offset, e.offset + e.length])
  }
  if (!spans.length) return text
  spans.sort((a, b) => b[0] - a[0])
  let out = text
  let floor = Number.POSITIVE_INFINITY
  for (const [start, end] of spans) {
    if (end > floor) continue
    out = out.slice(0, start) + HIDDEN + out.slice(end)
    floor = start
  }
  return out
}

// ─── scrub ───────────────────────────────────────────────────────────────

function isDeniedObject(obj: Record<string, unknown>, deny: DenySet): boolean {
  if ((obj._ === 'user' || obj._ === 'userEmpty') && typeof obj.id === 'number') return deny.isUser(obj.id)
  const chat = markedFromChatObject(obj)
  return chat !== null && deny.isChat(chat)
}

function fwdNamesDenied(fwd: unknown, deny: DenySet): boolean {
  if (!isRecord(fwd)) return false
  return deny.matchesTerm(fwd.fromName as string) ||
    deny.matchesTerm(fwd.postAuthor as string) ||
    deny.matchesTerm(fwd.savedFromName as string)
}

/** Reduces a message to the fields we use. Returns DROP when it must go. */
function prepareMessage(msg: Record<string, unknown>, deny: DenySet): Record<string, unknown> | typeof DROP {
  if (fwdNamesDenied(msg.fwdFrom, deny)) return DROP
  if (deny.matchesTerm(msg.postAuthor as string)) return DROP
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(msg)) if (MESSAGE_KEEP.has(k)) out[k] = msg[k]
  if (typeof msg.message === 'string') out.message = redactMentions(msg.message, msg.entities, deny)
  if (isRecord(msg.replyTo)) {
    if (fwdNamesDenied(msg.replyTo.replyFrom, deny)) return DROP
    const reply: Record<string, unknown> = {}
    for (const k of Object.keys(msg.replyTo)) if (REPLY_KEEP.has(k)) reply[k] = msg.replyTo[k]
    out.replyTo = reply
  }
  if (isRecord(msg.media)) out.media = { _: msg.media._ }
  return out
}

function scrubNode(v: unknown, deny: DenySet, key: string | null): Scrubbed {
  if (typeof v === 'number') {
    if (key === null) return v
    if (USER_KEYS.has(key) && deny.isUser(v)) return DROP
    if (CHAT_KEYS.has(key) && deny.isRawChat(v)) return DROP
    if (CHANNEL_KEYS.has(key) && deny.isRawChannel(v)) return DROP
    return v
  }
  if (typeof v !== 'object' || v === null || isOpaque(v)) return v
  if (Array.isArray(v)) {
    if (key !== null && USER_ARRAY_KEYS.has(key) && v.length && v.every((x) => typeof x === 'number')) {
      // A list of user ids (e.g. "added these users"). The list belongs
      // to its parent, so a denied id removes the parent.
      return v.some((x) => deny.isUser(x as number)) ? DROP : [...v]
    }
    const out: unknown[] = []
    for (const item of v) {
      const r = scrubNode(item, deny, null)
      if (r !== DROP) out.push(r)
    }
    return out
  }
  let obj = v as Record<string, unknown>
  if (isDeniedObject(obj, deny)) return DROP
  if (isMessage(obj)) {
    const prepared = prepareMessage(obj, deny)
    if (prepared === DROP) return DROP
    obj = prepared
  }
  const out: Record<string, unknown> = {}
  for (const [k, child] of Object.entries(obj)) {
    const r = scrubNode(child, deny, k)
    if (r === DROP) return DROP
    out[k] = r
  }
  return out
}

/**
 * Returns a copy of a response with every denied peer removed. Items in
 * lists are removed; a denied peer anywhere else removes its parent.
 * Throws DeniedContentError when the whole response is denied.
 */
export function scrub<T>(value: T, deny: DenySet): T {
  const r = scrubNode(value, deny, null)
  if (r === DROP) throw new DeniedContentError()
  return r as T
}
