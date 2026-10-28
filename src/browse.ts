import { Long, tl } from '@mtcute/core'
import { resolveChat } from './actions.js'
import { ToolError } from './errors.js'
import { type Names, type OutMessage, collectNames, formatMessage } from './format.js'
import { markedFromPeer, parseMarked } from './ids.js'
import { DeniedContentError } from './scrub.js'
import { type ChatType, loadDialogs, peerInfo } from './sync.js'
import { type Ctx, inputPeer, refreshCommonChats, verifyChat } from './verify.js'

// chats, search, resolve and chat: browse beyond the unread inbox.
// All pass every chat through verifyChat before it is shown. A group seen
// for the first time also has its recent history read, so a denied user
// who wrote there or was added there hides it. Shown chats are recorded as
// known, so read and draft work on them afterwards.

export const CHATS_PAGES = 5
export const SCAN_MESSAGES = 20
export const MAX_QUERY = 256

export type ChatsFolder = 'main' | 'archive' | 'all'

export interface ChatItem {
  chatId: string
  chatType: ChatType
  title: string
  username: string | null
  isBot: boolean
  folder: 'main' | 'archive'
  unreadCount: number
  lastMessage: OutMessage | null
}

export interface ChatsResult {
  ok: true
  verb: 'chats'
  complete: boolean
  cooldown: string | null
  items: ChatItem[]
}

export interface ResolveResult {
  ok: true
  verb: 'resolve'
  complete: boolean
  cooldown: string | null
  chat: ChatItem | null
}

export interface ChatResult {
  ok: true
  verb: 'chat'
  complete: boolean
  cooldown: string | null
  chat: ChatItem | null
}

export interface SearchHit extends OutMessage {
  chatId: string
  chatType: ChatType
  chatTitle: string
}

export interface SearchResult {
  ok: true
  verb: 'search'
  chatId: string | null
  complete: boolean
  cooldown: string | null
  nextCursor: string | null
  messages: SearchHit[]
}

interface SearchCursor {
  rate: number
  chatId: number | null
  id: number
}

export function queryArg(value: string | true | undefined, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_QUERY) throw new ToolError('bad_args')
  return value.trim()
}

// Telegram usernames: a letter, then letters, digits and underscores. Short
// collectible names have 4 characters, ordinary ones at least 5.
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/

export function usernameArg(value: string | undefined): string {
  const name = value?.startsWith('@') ? value.slice(1) : value
  if (!name || !USERNAME.test(name)) throw new ToolError('bad_args')
  return name
}

export function parseSearchCursor(raw: string | undefined): SearchCursor | null {
  if (raw === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ToolError('bad_args')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ToolError('bad_args')
  const { rate, chatId, id, ...rest } = parsed as Record<string, unknown>
  const int = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (Object.keys(rest).length || !int(rate) || !int(id)) throw new ToolError('bad_args')
  if (chatId !== null && (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId === 0)) throw new ToolError('bad_args')
  return { rate: rate as number, chatId: chatId as number | null, id: id as number }
}

function remember(ctx: Ctx, marked: number, inboundIds: number[]): void {
  const key = String(marked)
  const known = ctx.state.data.known[key]
  ctx.state.data.known[key] = {
    kind: parseMarked(marked)[0],
    lastInboundId: Math.max(known?.lastInboundId ?? 0, ...inboundIds),
    seenAt: ctx.now(),
  }
}

/** True when a chat may be shown: clean now, and its recent history proves no denied member. */
async function showable(ctx: Ctx, marked: number): Promise<boolean> {
  const verdict = await verifyChat(ctx, marked)
  if (verdict === 'budget') throw new ToolError('budget')
  if (verdict !== 'clean') return false
  if (marked > 0 || ctx.state.data.known[String(marked)]) return !ctx.deny.isMarked(marked)
  const peer = await inputPeer(ctx, marked)
  if (!peer) return false
  try {
    await ctx.tg.call({
      _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: SCAN_MESSAGES, maxId: 0, minId: 0, hash: Long.ZERO,
    })
  } catch (err) {
    if (err instanceof DeniedContentError) return false
    throw err
  }
  return !ctx.deny.isMarked(marked)
}

/** Calls fn, turning a cooldown into a stop and a spent budget into a skip. */
async function guarded<T>(result: { complete: boolean; cooldown: string | null }, fn: () => Promise<T>): Promise<T | 'stop' | 'skip'> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ToolError && err.code === 'cooldown') {
      result.complete = false
      result.cooldown = err.extra.until ?? null
      return 'stop'
    }
    if (err instanceof ToolError && err.code === 'budget') {
      result.complete = false
      return 'skip'
    }
    throw err
  }
}

export async function runChats(ctx: Ctx, folder: ChatsFolder, query: string | undefined, limit: number): Promise<ChatsResult> {
  const result: ChatsResult = { ok: true, verb: 'chats', complete: true, cooldown: null, items: [] }
  await refreshCommonChats(ctx)
  const folders: (0 | 1)[] = folder === 'main' ? [0] : folder === 'archive' ? [1] : [0, 1]
  const { candidates, complete } = await loadDialogs(ctx, folders, CHATS_PAGES)
  result.complete = complete
  const needle = query?.toLowerCase()

  for (const c of candidates) {
    if (result.items.length >= limit) break
    if (needle && !c.title.toLowerCase().includes(needle) && !c.username?.toLowerCase().includes(needle)) continue
    const ok = await guarded(result, () => showable(ctx, c.marked))
    if (ok === 'stop') break
    if (ok !== true || ctx.deny.isMarked(c.marked)) continue
    const top = c.top && c.top._ === 'message' ? c.top : undefined
    remember(ctx, c.marked, top && !top.out ? [top.id] : [])
    result.items.push({
      chatId: String(c.marked),
      chatType: c.type,
      title: c.title,
      username: c.username,
      isBot: c.isBot,
      folder: c.folderId === 1 ? 'archive' : 'main',
      unreadCount: c.dialog.unreadCount,
      lastMessage: top ? formatMessage(top, c.marked, ctx.selfId, c.names) : null,
    })
  }

  // A later chat may have proved an earlier one denied. Drop it again.
  result.items = result.items.filter((i) => !ctx.deny.isMarked(Number(i.chatId)))
  return result
}

/**
 * One chat by its public username, in the chats item shape, or null.
 * Not found, denied, and a group with a denied member all give null.
 * Resolve does not read the dialog list, so folder is main and unreadCount 0.
 */
export async function runResolve(ctx: Ctx, username: string): Promise<ResolveResult> {
  const result: ResolveResult = { ok: true, verb: 'resolve', complete: true, cooldown: null, chat: null }
  await refreshCommonChats(ctx)
  let res: { peer?: unknown; users?: tl.TypeUser[]; chats?: tl.TypeChat[] }
  try {
    res = (await ctx.tg.call({ _: 'contacts.resolveUsername', username })) as unknown as typeof res
  } catch (err) {
    // The scrub refuses a response about a denied peer. That must look like not found.
    if (err instanceof DeniedContentError) return result
    if (tl.RpcError.is(err) && (err.text === 'USERNAME_NOT_OCCUPIED' || err.text === 'USERNAME_INVALID')) return result
    throw err
  }
  const marked = markedFromPeer(res.peer)
  const names = collectNames(res)
  const info = marked === null ? null : peerInfo(ctx, marked, names)
  if (marked === null || !info) return result
  const ok = await guarded(result, () => showable(ctx, marked))
  if (ok !== true || ctx.deny.isMarked(marked)) return result

  const peer = await inputPeer(ctx, marked)
  if (!peer) return result
  const history = await guarded(result, async () => {
    try {
      return (await ctx.tg.call({
        _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 1, maxId: 0, minId: 0, hash: Long.ZERO,
      })) as tl.messages.TypeMessages
    } catch (err) {
      if (err instanceof DeniedContentError) return null
      throw err
    }
  })
  if (history === null || history === 'stop' || history === 'skip' || ctx.deny.isMarked(marked)) return result
  const top = history._ === 'messages.messagesNotModified' ? undefined : history.messages.find((m): m is tl.RawMessage => m._ === 'message')
  remember(ctx, marked, top && !top.out ? [top.id] : [])
  result.chat = {
    chatId: String(marked),
    chatType: info.type,
    title: info.title,
    username: info.username,
    isBot: info.isBot,
    folder: 'main',
    unreadCount: 0,
    lastMessage: top && history._ !== 'messages.messagesNotModified' ? formatMessage(top, marked, ctx.selfId, collectNames(history, names)) : null,
  }
  return result
}

/**
 * One chat by its marked id, in the chats item shape, or null.
 * Denied, a group with a denied member, and a chat this account cannot
 * reach all give null. A user or supergroup needs an access hash from the
 * session's peer cache, so a chat never seen before also gives null.
 */
export async function runChat(ctx: Ctx, marked: number): Promise<ChatResult> {
  const result: ChatResult = { ok: true, verb: 'chat', complete: true, cooldown: null, chat: null }
  if (ctx.deny.isMarked(marked)) return result
  await refreshCommonChats(ctx)
  const [kind, rawId] = parseMarked(marked)
  // A basic group needs no access hash, so it works without the cache.
  const peer = (await inputPeer(ctx, marked)) ?? (kind === 'chat' && !ctx.deny.isMarked(marked) ? { _: 'inputPeerChat' as const, chatId: rawId } : null)
  if (!peer) return result
  const res = await guarded(result, async () => {
    try {
      return (await ctx.tg.call({ _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer }] })) as tl.messages.TypePeerDialogs
    } catch (err) {
      // The scrub refuses a response about a denied peer. That must look like not found.
      if (err instanceof DeniedContentError) return null
      // Not a member, no access, or no such chat.
      if (tl.RpcError.is(err) && (err.code === 400 || err.code === 403)) return null
      throw err
    }
  })
  if (res === null || res === 'stop' || res === 'skip' || ctx.deny.isMarked(marked)) return result
  const dialog = res.dialogs.find((d): d is tl.RawDialog => d._ === 'dialog' && markedFromPeer(d.peer) === marked)
  const names = collectNames(res)
  const info = peerInfo(ctx, marked, names)
  if (!dialog || !info) return result
  const ok = await guarded(result, () => showable(ctx, marked))
  if (ok !== true || ctx.deny.isMarked(marked)) return result

  const top = res.messages.find((m): m is tl.RawMessage => m._ === 'message' && m.id === dialog.topMessage && markedFromPeer(m.peerId) === marked)
  remember(ctx, marked, top && !top.out ? [top.id] : [])
  result.chat = {
    chatId: String(marked),
    chatType: info.type,
    title: info.title,
    username: info.username,
    isBot: info.isBot,
    folder: dialog.folderId === 1 ? 'archive' : 'main',
    unreadCount: dialog.unreadCount,
    lastMessage: top ? formatMessage(top, marked, ctx.selfId, names) : null,
  }
  return result
}

type SearchRes = Exclude<tl.messages.TypeMessages, tl.messages.RawMessagesNotModified>

function hitsFrom(ctx: Ctx, res: SearchRes, names: Names, allowed: (marked: number) => boolean): SearchHit[] {
  const hits: SearchHit[] = []
  for (const m of res.messages) {
    const chat = markedFromPeer((m as { peerId?: unknown }).peerId)
    if (chat === null || !allowed(chat)) continue
    const info = peerInfo(ctx, chat, names)
    const msg = info ? formatMessage(m, chat, ctx.selfId, names) : null
    if (!info || !msg) continue
    hits.push({ ...msg, chatId: String(chat), chatType: info.type, chatTitle: info.title })
  }
  return hits
}

/** Where the next page starts: the oldest message that is still showable. */
function nextCursor(ctx: Ctx, res: SearchRes, hasMore: boolean): string | null {
  if (!hasMore) return null
  for (let i = res.messages.length - 1; i >= 0; i--) {
    const m = res.messages[i] as { id: number; date?: number; peerId?: unknown }
    const chat = markedFromPeer(m.peerId)
    if (chat === null || ctx.deny.isMarked(chat)) continue
    const rate = 'nextRate' in res && typeof res.nextRate === 'number' ? res.nextRate : (m.date ?? 0)
    return JSON.stringify({ rate, chatId: chat, id: m.id } satisfies SearchCursor)
  }
  return null
}

async function searchInChat(ctx: Ctx, marked: number, query: string, limit: number, cursor: SearchCursor | null): Promise<SearchResult> {
  if (cursor && cursor.chatId !== null && cursor.chatId !== marked) throw new ToolError('bad_args')
  const chat = await resolveChat(ctx, marked)
  const res = (await ctx.tg.call({
    _: 'messages.search',
    peer: chat.peer,
    q: query,
    filter: { _: 'inputMessagesFilterEmpty' },
    minDate: 0,
    maxDate: 0,
    offsetId: cursor?.id ?? 0,
    addOffset: 0,
    limit,
    maxId: 0,
    minId: 0,
    hash: Long.ZERO,
  })) as tl.messages.TypeMessages
  if (ctx.deny.isMarked(marked)) throw new ToolError('chat_unavailable')
  const result: SearchResult = { ok: true, verb: 'search', chatId: String(marked), complete: true, cooldown: null, nextCursor: null, messages: [] }
  if (res._ === 'messages.messagesNotModified') return result
  result.messages = hitsFrom(ctx, res, collectNames(res), (c) => c === marked)
  result.nextCursor = nextCursor(ctx, res, res._ !== 'messages.messages' && res.messages.length > 0)
  return result
}

async function searchGlobal(ctx: Ctx, query: string, limit: number, cursor: SearchCursor | null): Promise<SearchResult> {
  const result: SearchResult = { ok: true, verb: 'search', chatId: null, complete: true, cooldown: null, nextCursor: null, messages: [] }
  await refreshCommonChats(ctx)
  const offsetPeer = (cursor?.chatId ? await inputPeer(ctx, cursor.chatId) : null) ?? { _: 'inputPeerEmpty' }
  const res = (await ctx.tg.call({
    _: 'messages.searchGlobal',
    q: query,
    filter: { _: 'inputMessagesFilterEmpty' },
    minDate: 0,
    maxDate: 0,
    offsetRate: cursor?.rate ?? 0,
    offsetPeer,
    offsetId: cursor?.id ?? 0,
    limit,
  })) as tl.messages.TypeMessages
  if (res._ === 'messages.messagesNotModified') return result
  const names = collectNames(res)

  // One membership check per chat, then keep the hits from clean chats.
  const verdicts = new Map<number, boolean>()
  for (const m of res.messages) {
    const chat = markedFromPeer((m as { peerId?: unknown }).peerId)
    if (chat === null || verdicts.has(chat) || !peerInfo(ctx, chat, names)) continue
    const ok = await guarded(result, () => showable(ctx, chat))
    if (ok === 'stop') break
    verdicts.set(chat, ok === true)
  }
  const shown = (c: number) => verdicts.get(c) === true && !ctx.deny.isMarked(c)
  result.messages = hitsFrom(ctx, res, names, shown)
  for (const chat of new Set(result.messages.map((m) => Number(m.chatId)))) {
    remember(ctx, chat, result.messages.filter((m) => Number(m.chatId) === chat && !m.out).map((m) => m.id))
  }
  const more = ('nextRate' in res && res.nextRate !== undefined) || (res._ !== 'messages.messages' && res.messages.length >= limit)
  result.nextCursor = nextCursor(ctx, res, more)
  return result
}

export async function runSearch(
  ctx: Ctx,
  query: string,
  chat: number | undefined,
  limit: number,
  cursor: SearchCursor | null,
): Promise<SearchResult> {
  const result = chat === undefined ? await searchGlobal(ctx, query, limit, cursor) : await searchInChat(ctx, chat, query, limit, cursor)
  // A later hit may have proved an earlier chat denied. Drop it again.
  result.messages = result.messages.filter((m) => !ctx.deny.isMarked(Number(m.chatId)))
  return result
}
