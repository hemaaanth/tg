import { Long, type tl } from '@mtcute/core'
import { randomLong } from '@mtcute/core/utils.js'
import { MAX_DAILY_SEND_CAP } from './config.js'
import { ToolError } from './errors.js'
import { type OutMessage, collectNames, messagesFor, userName } from './format.js'
import { parseMarked } from './ids.js'
import type { KnownChat } from './state.js'
import { MAX_MESSAGES_PER_CHAT } from './sync.js'
import { type Ctx, inputPeer, verifyChat } from './verify.js'

// read, draft, mark-read-archive, send, whoami.
// Every chat verb needs a chat that a sync has already shown, and a fresh
// membership check. Denied, unknown and unseen chats all give the same
// error, so the tool cannot be used to test who is denied.

export interface ResolvedChat {
  marked: number
  peer: tl.TypeInputPeer
  known: KnownChat
}

export async function resolveChat(ctx: Ctx, marked: number): Promise<ResolvedChat> {
  const unavailable = new ToolError('chat_unavailable')
  if (ctx.deny.isMarked(marked)) throw unavailable
  const known = ctx.state.data.known[String(marked)]
  if (!known) throw unavailable
  const verdict = await verifyChat(ctx, marked)
  if (verdict === 'budget') throw new ToolError('budget')
  if (verdict !== 'clean') throw unavailable
  const peer = await inputPeer(ctx, marked)
  if (!peer) throw unavailable
  return { marked, peer, known }
}

function replyTo(id: number | undefined): tl.TypeInputReplyTo | undefined {
  return id === undefined ? undefined : { _: 'inputReplyToMessage', replyToMsgId: id }
}

export interface ReadResult {
  ok: true
  verb: 'read'
  chatId: string
  messages: OutMessage[]
}

export async function runRead(ctx: Ctx, marked: number, limit = 20, before?: number): Promise<ReadResult> {
  const chat = await resolveChat(ctx, marked)
  const res = (await ctx.tg.call({
    _: 'messages.getHistory',
    peer: chat.peer,
    offsetId: before ?? 0,
    offsetDate: 0,
    addOffset: 0,
    limit: Math.min(limit, MAX_MESSAGES_PER_CHAT),
    maxId: 0,
    minId: 0,
    hash: Long.ZERO,
  })) as tl.messages.TypeMessages
  if (ctx.deny.isMarked(marked)) throw new ToolError('chat_unavailable')
  const messages = res._ === 'messages.messagesNotModified' ? [] : messagesFor(res, marked, ctx.selfId, collectNames(res))
  return { ok: true, verb: 'read', chatId: String(marked), messages }
}

export async function runDraft(ctx: Ctx, marked: number, text: string, reply?: number) {
  if (ctx.config.readOnly) throw new ToolError('read_only')
  const chat = await resolveChat(ctx, marked)
  await ctx.tg.call({ _: 'messages.saveDraft', peer: chat.peer, message: text, replyTo: replyTo(reply) })
  return { ok: true as const, verb: 'draft' as const, chatId: String(marked) }
}

export async function runMarkReadArchive(ctx: Ctx, marked: number, maxId: number) {
  if (ctx.config.readOnly) throw new ToolError('read_only')
  const chat = await resolveChat(ctx, marked)
  const [kind] = parseMarked(marked)
  if (chat.peer._ === 'inputPeerChannel') {
    await ctx.tg.call({
      _: 'channels.readHistory',
      channel: { _: 'inputChannel', channelId: chat.peer.channelId, accessHash: chat.peer.accessHash },
      maxId,
    })
  } else {
    await ctx.tg.call({ _: 'messages.readHistory', peer: chat.peer, maxId })
  }
  if (kind !== 'user') await ctx.tg.call({ _: 'messages.readMentions', peer: chat.peer })
  // Folder 1 is the Archive. sync only lists folder 0.
  await ctx.tg.call({ _: 'folders.editPeerFolders', folderPeers: [{ _: 'inputFolderPeer', peer: chat.peer, folderId: 1 }] })
  return { ok: true as const, verb: 'mark-read-archive' as const, chatId: String(marked), archived: true }
}

export async function runSend(ctx: Ctx, marked: number, text: string, reply?: number) {
  if (ctx.config.readOnly) throw new ToolError('read_only')
  if (!ctx.config.allowSend) throw new ToolError('send_disabled')
  const cap = Math.min(ctx.config.dailySendCap, MAX_DAILY_SEND_CAP)
  const chat = await resolveChat(ctx, marked)
  // Only reply where someone wrote to us first.
  if (chat.known.lastInboundId <= 0) throw new ToolError('chat_unavailable')
  if (ctx.state.sendsToday(ctx.now()) >= cap) throw new ToolError('send_cap')
  // Count the send before the call. A crash then errs on the safe side.
  ctx.state.data.sends.push(ctx.now())
  ctx.state.save()
  await ctx.tg.call({
    _: 'messages.sendMessage',
    peer: chat.peer,
    message: text,
    randomId: randomLong(),
    replyTo: replyTo(reply),
  })
  return {
    ok: true as const,
    verb: 'send' as const,
    chatId: String(marked),
    sendsToday: ctx.state.sendsToday(ctx.now()),
    dailySendCap: cap,
  }
}

export async function runWhoami(ctx: Ctx) {
  const res = (await ctx.tg.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] })) as tl.TypeUser[]
  const self = res.find((u): u is tl.RawUser => u._ === 'user')
  if (!self) throw new ToolError('not_logged_in')
  return { ok: true as const, verb: 'whoami' as const, userId: String(self.id), name: userName(self), username: self.username ?? null }
}
