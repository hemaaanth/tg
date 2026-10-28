import type { RpcCallMiddleware } from '@mtcute/core'
import type { DenySet } from './deny-set.js'
import { ToolError } from './errors.js'
import { markChat, markedFromChatObject, markedFromPeer } from './ids.js'
import { discover, scrub } from './scrub.js'

// The deny guard is the first RPC middleware. It
//   1. refuses any method not on the allowlist for this run,
//   2. refuses any request that names a denied peer,
//   3. answers membership probes with a small stub (the raw answer names
//      the denied user, so it must never reach the cache),
//   4. discovers groups that hold denied users, then
//   5. scrubs the response before mtcute's cache and storage see it.

export type Mode = 'sync' | 'chats' | 'search' | 'read' | 'draft' | 'dismiss' | 'send' | 'whoami' | 'login' | 'deny-lookup' | 'work-audit' | 'invite-work-user' | 'resolve' | 'chat'

const SESSION = ['help.getConfig', 'help.getNearestDc', 'auth.exportAuthorization', 'auth.importAuthorization']
const PROBES = ['messages.getCommonChats', 'channels.getParticipant', 'messages.getFullChat']

export const WRITE_METHODS = new Set([
  'messages.saveDraft',
  'messages.readHistory',
  'channels.readHistory',
  'messages.readMentions',
  'folders.editPeerFolders',
  'messages.sendMessage',
  'messages.addChatUser',
  'channels.inviteToChannel',
])

export const ALLOWED: Record<Mode, ReadonlySet<string>> = {
  sync: new Set([...SESSION, ...PROBES, 'messages.getDialogs', 'messages.getHistory']),
  chats: new Set([...SESSION, ...PROBES, 'messages.getDialogs', 'messages.getHistory']),
  search: new Set([...SESSION, ...PROBES, 'messages.searchGlobal', 'messages.search', 'messages.getHistory']),
  read: new Set([...SESSION, ...PROBES, 'messages.getHistory']),
  draft: new Set([...SESSION, ...PROBES, 'messages.saveDraft']),
  dismiss: new Set([
    ...SESSION,
    ...PROBES,
    'messages.readHistory',
    'channels.readHistory',
    'messages.readMentions',
    'folders.editPeerFolders',
  ]),
  send: new Set([...SESSION, ...PROBES, 'messages.sendMessage']),
  whoami: new Set([...SESSION, 'users.getUsers']),
  login: new Set([
    ...SESSION,
    'auth.sendCode',
    'auth.signIn',
    'auth.resendCode',
    'auth.cancelCode',
    'account.getPassword',
    'auth.checkPassword',
    'users.getUsers',
  ]),
  'deny-lookup': new Set([...SESSION, 'messages.getDialogs', 'contacts.getContacts']),
  'work-audit': new Set([...SESSION, ...PROBES, 'messages.getDialogs', 'contacts.resolveUsername']),
  'invite-work-user': new Set([...SESSION, ...PROBES, 'contacts.resolveUsername', 'messages.addChatUser', 'channels.inviteToChannel']),
  resolve: new Set([...SESSION, ...PROBES, 'contacts.resolveUsername', 'messages.getHistory']),
  chat: new Set([...SESSION, ...PROBES, 'messages.getPeerDialogs', 'messages.getHistory']),
}

/** Stub results returned for probe methods instead of the raw answer. */
export interface CommonChatsProbe {
  _: 'tgi.commonChats'
  count: number
  lastRawId: number | null
}
export interface FullChatProbe {
  _: 'tgi.fullChat'
  status: 'clean' | 'denied' | 'unknown'
  memberIds?: number[]
}
export interface ParticipantProbe {
  _: 'tgi.participant'
}

export interface GuardOptions {
  deny: DenySet
  mode: Mode
  readOnly: boolean
  allowSend: boolean
  allowWorkInvite?: boolean
  /** Admin only: sees the raw response before the scrub. */
  onRaw?: (method: string, res: unknown) => void
}

const ID_KEYS: Record<string, (v: number, deny: DenySet) => boolean> = {
  userId: (v, d) => d.isUser(v),
  chatId: (v, d) => d.isRawChat(v),
  channelId: (v, d) => d.isRawChannel(v),
}

/** True when a request names a denied peer anywhere. */
export function requestNamesDenied(value: unknown, deny: DenySet, key: string | null = null): boolean {
  if (typeof value === 'number') {
    const check = key === null ? undefined : ID_KEYS[key]
    return check ? check(value, deny) : false
  }
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return false
  if (Array.isArray(value)) return value.some((v) => requestNamesDenied(v, deny, null))
  const obj = value as Record<string, unknown>
  const marked = markedFromPeer(obj)
  if (marked !== null && deny.isMarked(marked)) return true
  return Object.entries(obj).some(([k, v]) => requestNamesDenied(v, deny, k))
}

function isRpcError(res: unknown): res is { _: 'mt_rpc_error'; errorCode: number; errorMessage: string } {
  return typeof res === 'object' && res !== null && (res as { _?: unknown })._ === 'mt_rpc_error'
}

function checkRequest(req: Record<string, unknown>, opts: GuardOptions): void {
  const { deny } = opts
  const method = req._ as string
  if (!ALLOWED[opts.mode].has(method)) throw new ToolError('method_blocked')
  if (WRITE_METHODS.has(method) && opts.readOnly) throw new ToolError('read_only')
  if (method === 'messages.sendMessage' && !opts.allowSend) throw new ToolError('send_disabled')
  if ((method === 'messages.addChatUser' || method === 'channels.inviteToChannel') && !opts.allowWorkInvite) {
    throw new ToolError('invite_disabled')
  }

  if (method === 'users.getUsers') {
    const ids = req.id as Array<{ _: string }>
    if (!Array.isArray(ids) || ids.length !== 1 || ids[0]._ !== 'inputUserSelf') throw new ToolError('method_blocked')
    return
  }

  // Probes name a denied user on purpose. That field must be denied;
  // the rest of the request must not be.
  let rest: Record<string, unknown> = req
  if (method === 'messages.getCommonChats') {
    const target = markedFromPeer(req.userId)
    if (target === null || !deny.isUser(target)) throw new ToolError('method_blocked')
    rest = { ...req, userId: undefined }
  } else if (method === 'channels.getParticipant') {
    const target = markedFromPeer(req.participant)
    if (target === null) throw new ToolError('method_blocked')
    if (deny.isUser(target)) rest = { ...req, participant: undefined }
    else if (opts.mode !== 'work-audit' && opts.mode !== 'invite-work-user') throw new ToolError('method_blocked')
  }
  if (requestNamesDenied(rest, deny)) throw new ToolError('chat_unavailable')
}

function commonChatsProbe(res: Record<string, unknown>, deny: DenySet): CommonChatsProbe {
  const chats = Array.isArray(res.chats) ? res.chats : []
  let lastRawId: number | null = null
  for (const chat of chats) {
    const marked = markedFromChatObject(chat)
    if (marked !== null) deny.addChat(marked)
    if (chat && typeof (chat as { id?: unknown }).id === 'number') lastRawId = (chat as { id: number }).id
  }
  return { _: 'tgi.commonChats', count: chats.length, lastRawId }
}

function fullChatProbe(req: Record<string, unknown>, res: Record<string, unknown>, deny: DenySet, includeMembers: boolean): FullChatProbe {
  const chatId = req.chatId as number
  const full = res.fullChat as Record<string, unknown> | undefined
  const participants = full?.participants as Record<string, unknown> | undefined
  if (!participants || participants._ !== 'chatParticipants' || !Array.isArray(participants.participants)) {
    return { _: 'tgi.fullChat', status: 'unknown' }
  }
  const hit = participants.participants.some((p) => {
    const uid = (p as { userId?: unknown }).userId
    return typeof uid === 'number' && deny.isUser(uid)
  })
  if (hit) {
    deny.addChat(markChat(chatId))
    return { _: 'tgi.fullChat', status: 'denied' }
  }
  const memberIds = includeMembers
    ? participants.participants.flatMap((p) => {
        const uid = (p as { userId?: unknown }).userId
        return typeof uid === 'number' && !deny.isUser(uid) ? [uid] : []
      })
    : undefined
  return { _: 'tgi.fullChat', status: 'clean', ...(memberIds ? { memberIds } : {}) }
}

export function denyGuard(opts: GuardOptions): RpcCallMiddleware {
  return async (ctx, next) => {
    const req = ctx.request as unknown as Record<string, unknown>
    checkRequest(req, opts)
    const res = await next(ctx)
    if (isRpcError(res) || typeof res !== 'object' || res === null) return res
    const method = req._ as string
    const raw = res as Record<string, unknown>

    if (method === 'messages.getCommonChats') return commonChatsProbe(raw, opts.deny)
    if (method === 'messages.getFullChat') {
      return fullChatProbe(req, raw, opts.deny, opts.mode === 'work-audit' || opts.mode === 'invite-work-user')
    }
    if (method === 'channels.getParticipant') {
      const target = markedFromPeer(req.participant)
      if (target !== null && opts.deny.isUser(target)) {
        const channel = markedFromPeer(req.channel)
        if (channel !== null) opts.deny.addChat(channel)
      }
      return { _: 'tgi.participant' } satisfies ParticipantProbe
    }

    discover(raw, opts.deny)
    opts.onRaw?.(method, raw)
    return scrub(raw, opts.deny)
  }
}
