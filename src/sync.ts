import { Long, type tl } from '@mtcute/core'
import { ToolError } from './errors.js'
import { type Names, type OutMessage, collectNames, messagesFor, userName } from './format.js'
import { markedFromPeer, parseMarked } from './ids.js'
import { type Ctx, inputPeer, refreshCommonChats, verifyChat } from './verify.js'

// sync: unread DMs and groups in the main folder (folder 0).

export const DIALOG_PAGES = 2
export const DIALOG_PAGE_SIZE = 100
export const MAX_MESSAGES_PER_CHAT = 50

export type ChatType = 'user' | 'group' | 'supergroup'

export interface SyncItem {
  chatId: string
  chatType: ChatType
  title: string
  username: string | null
  isBot: boolean
  unreadCount: number
  unreadMentions: number
  lastReadInboxMaxId: number
  topMessageId: number
  unchanged: boolean
  messages: OutMessage[]
}

export interface SyncResult {
  ok: true
  verb: 'sync'
  syncedAt: string
  complete: boolean
  cooldown: string | null
  cursor: Record<string, number>
  items: SyncItem[]
}

type DialogsRes = tl.messages.RawDialogs | tl.messages.RawDialogsSlice

export interface DialogCandidate {
  dialog: tl.RawDialog
  marked: number
  type: ChatType
  title: string
  username: string | null
  isBot: boolean
  folderId: 0 | 1
  canInvite: boolean
  top: tl.TypeMessage | undefined
  names: Names
}

export function parseCursor(raw: string | undefined): Record<string, number> {
  if (raw === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ToolError('bad_args')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ToolError('bad_args')
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^-?\d{1,16}$/.test(k) || typeof v !== 'number' || !Number.isSafeInteger(v)) throw new ToolError('bad_args')
    out[k] = v
  }
  return out
}

export interface PeerInfo {
  type: ChatType
  title: string
  username: string | null
  isBot: boolean
  canInvite: boolean
}

/** What a DM, group or megagroup is called. Null for self, deleted users, left groups and broadcast channels. */
export function peerInfo(ctx: Ctx, marked: number, names: Names): PeerInfo | null {
  if (ctx.deny.isMarked(marked)) return null
  const [kind] = parseMarked(marked)
  if (kind === 'user') {
    const u = names.users.get(marked)
    if (!u || u.self || u.deleted || marked === ctx.selfId) return null
    return { type: 'user', title: userName(u) ?? '', username: u.username ?? null, isBot: Boolean(u.bot), canInvite: false }
  }
  const c = names.chats.get(marked)
  if (!c) return null
  if (c._ === 'chat') {
    if (c.left || c.deactivated || c.migratedTo) return null
    return { type: 'group', title: c.title, username: null, isBot: false, canInvite: Boolean(c.creator || c.adminRights?.inviteUsers) }
  }
  // Broadcast channels are out of scope. Only megagroups.
  if (!c.megagroup || c.broadcast || c.left) return null
  return {
    type: 'supergroup',
    title: c.title,
    username: c.username ?? null,
    isBot: false,
    canInvite: Boolean(c.creator || c.adminRights?.inviteUsers),
  }
}

function candidateFrom(ctx: Ctx, dialog: tl.RawDialog, names: Names, tops: Map<string, tl.TypeMessage>, folderId: 0 | 1): DialogCandidate | null {
  const marked = markedFromPeer(dialog.peer)
  if (marked === null) return null
  const info = peerInfo(ctx, marked, names)
  if (!info) return null
  const { type, title, username, isBot, canInvite } = info
  return { dialog, marked, type, title, username, isBot, folderId, canInvite, top: tops.get(`${marked}:${dialog.topMessage}`), names }
}

export async function loadDialogs(
  ctx: Ctx,
  folders: readonly (0 | 1)[] = [0],
  pageLimit = DIALOG_PAGES,
): Promise<{
  candidates: DialogCandidate[]
  complete: boolean
  stops: Array<{ folderId: 0 | 1; page: number; loaded: number; count: number; reason: string }>
}> {
  const candidates: DialogCandidate[] = []
  const stops: Array<{ folderId: 0 | 1; page: number; loaded: number; count: number; reason: string }> = []
  let complete = true
  for (const folderId of folders) {
    let offsetDate = 0
    let offsetId = 0
    let offsetPeer: tl.TypeInputPeer = { _: 'inputPeerEmpty' }
    let loaded = 0
    for (let page = 0; page < pageLimit; page++) {
      const res = (await ctx.tg.call({
        _: 'messages.getDialogs', folderId, offsetDate, offsetId, offsetPeer, limit: DIALOG_PAGE_SIZE, hash: Long.ZERO,
      })) as DialogsRes
      const names = collectNames(res)
      const tops = new Map<string, tl.TypeMessage>()
      for (const m of res.messages) {
        const peer = markedFromPeer((m as { peerId?: unknown }).peerId)
        if (peer !== null) tops.set(`${peer}:${m.id}`, m)
      }
      const dialogs = res.dialogs.filter((d): d is tl.RawDialog => d._ === 'dialog')
      for (const d of dialogs) {
        const c = candidateFrom(ctx, d, names, tops, folderId)
        if (c) candidates.push(c)
      }
      loaded += res.dialogs.length
      if (res._ !== 'messages.dialogsSlice') break
      // Telegram's count can include stale dialogs that an empty page cannot retrieve.
      if (res.dialogs.length === 0) break
      const last = dialogs[dialogs.length - 1]
      const lastMarked = last ? markedFromPeer(last.peer) : null
      const lastTop = last && lastMarked !== null ? tops.get(`${lastMarked}:${last.topMessage}`) : undefined
      const lastPeer = lastMarked !== null ? await inputPeer(ctx, lastMarked) : null
      if (!last || !lastPeer) {
        complete = false
        stops.push({ folderId, page: page + 1, loaded, count: res.count, reason: last ? 'peer_unavailable' : 'dialog_unavailable' })
        break
      }
      const nextDate = (lastTop as { date?: number } | undefined)?.date ?? 0
      const nextId = last.topMessage
      if (nextId === offsetId && markedFromPeer(offsetPeer) === lastMarked) {
        complete = false
        stops.push({ folderId, page: page + 1, loaded, count: res.count, reason: 'repeated_cursor' })
        break
      }
      if (loaded >= res.count) break
      if (page === pageLimit - 1) {
        complete = false
        stops.push({ folderId, page: page + 1, loaded, count: res.count, reason: 'page_limit' })
        break
      }
      offsetDate = nextDate
      offsetId = nextId
      offsetPeer = lastPeer
    }
  }
  return { candidates, complete, stops }
}

async function loadMessages(ctx: Ctx, c: DialogCandidate): Promise<OutMessage[] | null> {
  const d = c.dialog
  const top = c.top
  if (d.unreadCount <= 1 && top && top._ === 'message' && !top.out && top.id > d.readInboxMaxId) {
    return messagesFor({ messages: [top] }, c.marked, ctx.selfId, c.names)
  }
  const peer = await inputPeer(ctx, c.marked)
  if (!peer) return null
  const res = (await ctx.tg.call({
    _: 'messages.getHistory',
    peer,
    offsetId: 0,
    offsetDate: 0,
    addOffset: 0,
    limit: Math.min(Math.max(d.unreadCount, 1), MAX_MESSAGES_PER_CHAT),
    maxId: 0,
    minId: d.readInboxMaxId,
    hash: Long.ZERO,
  })) as tl.messages.TypeMessages
  if (res._ === 'messages.messagesNotModified') return []
  return messagesFor(res, c.marked, ctx.selfId, collectNames(res))
}

export async function runSync(ctx: Ctx, since: Record<string, number>): Promise<SyncResult> {
  const result: SyncResult = {
    ok: true,
    verb: 'sync',
    syncedAt: new Date(ctx.now()).toISOString(),
    complete: true,
    cooldown: null,
    cursor: {},
    items: [],
  }

  await refreshCommonChats(ctx)
  const { candidates, complete } = await loadDialogs(ctx)
  result.complete = complete

  for (const c of candidates) {
    const d = c.dialog
    const unread = d.unreadCount > 0 || Boolean(d.unreadMark)
    const key = String(c.marked)
    if (!unread) continue

    try {
      const verdict = await verifyChat(ctx, c.marked)
      if (verdict === 'budget') {
        result.complete = false
        continue
      }
      if (verdict !== 'clean') continue

      const known = ctx.state.data.known[key]
      let messages: OutMessage[] = []
      const unchanged = (since[key] ?? 0) >= d.topMessage
      if (!unchanged) {
        const loaded = await loadMessages(ctx, c)
        if (loaded === null) continue
        messages = loaded
      }
      // A message in this batch may have proved a denied member.
      if (ctx.deny.isMarked(c.marked)) continue

      const inbound = messages.filter((m) => !m.out).map((m) => m.id)
      const topInbound = c.top && c.top._ === 'message' && !c.top.out ? c.top.id : 0
      ctx.state.data.known[key] = {
        kind: parseMarked(c.marked)[0],
        lastInboundId: Math.max(known?.lastInboundId ?? 0, topInbound, ...inbound),
        seenAt: ctx.now(),
      }
      result.cursor[key] = d.topMessage
      result.items.push({
        chatId: key,
        chatType: c.type,
        title: c.title,
        username: c.username,
        isBot: c.isBot,
        unreadCount: d.unreadCount,
        unreadMentions: d.unreadMentionsCount,
        lastReadInboxMaxId: d.readInboxMaxId,
        topMessageId: d.topMessage,
        unchanged,
        messages,
      })
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cooldown') {
        result.complete = false
        result.cooldown = err.extra.until ?? null
        break
      }
      if (err instanceof ToolError && err.code === 'budget') {
        result.complete = false
        continue
      }
      throw err
    }
  }

  // A later chat may have proved an earlier one denied. Drop it again.
  result.items = result.items.filter((i) => !ctx.deny.isMarked(Number(i.chatId)))
  for (const k of Object.keys(result.cursor)) if (ctx.deny.isMarked(Number(k))) delete result.cursor[k]
  ctx.state.data.lastSyncAt = ctx.now()
  return result
}
