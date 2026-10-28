import { Long, tl } from '@mtcute/core'
import type { BaseTelegramClient } from '@mtcute/core/client.js'
import type { Config } from './config.js'
import type { DenySet, Denylist } from './deny-set.js'
import { ToolError } from './errors.js'
import type { CommonChatsProbe, FullChatProbe } from './guard.js'
import { SERVICE_USER_ID, parseMarked } from './ids.js'
import { DAY_MS, type Membership, type StateStore } from './state.js'

// Group membership checks. A group is shown only when we can show that
// no denied user is in it. Anything we cannot check is hidden.

export interface Ctx {
  tg: BaseTelegramClient
  deny: DenySet
  state: StateStore
  config: Config
  denylist: Denylist
  selfId: number
  now: () => number
}

export type Verdict = 'clean' | 'denied' | 'unknown' | 'budget'

function isRpc(err: unknown, text?: string): boolean {
  return tl.RpcError.is(err) && (text === undefined || err.text === text)
}

function probeUsers(ctx: Ctx): { users: tl.RawInputUser[]; missingHash: boolean } {
  const users: tl.RawInputUser[] = []
  let missingHash = false
  for (const u of ctx.denylist.users) {
    if (u.id === SERVICE_USER_ID) continue
    if (u.accessHash === null) {
      missingHash = true
      continue
    }
    users.push({ _: 'inputUser', userId: u.id, accessHash: Long.fromString(u.accessHash) })
  }
  return { users, missingHash }
}

/**
 * Asks Telegram which groups we share with each denied user, and adds
 * them all to the deny set. Runs at most once a day per user.
 */
export async function refreshCommonChats(ctx: Ctx): Promise<void> {
  const now = ctx.now()
  for (const user of probeUsers(ctx).users) {
    const key = String(user.userId)
    const last = ctx.state.data.commonChatsAt[key] ?? 0
    if (now - last < DAY_MS) continue
    let maxId = 0
    try {
      for (let page = 0; page < 10; page++) {
        const res = (await ctx.tg.call({
          _: 'messages.getCommonChats',
          userId: user,
          maxId,
          limit: 100,
        })) as unknown as CommonChatsProbe
        if (res.count === 0 || res.lastRawId === null || res.lastRawId === maxId) break
        maxId = res.lastRawId
        if (res.count < 100) break
      }
      ctx.state.data.commonChatsAt[key] = now
    } catch (err) {
      if (err instanceof ToolError && err.code !== 'budget') throw err
      // A stale access hash or a spent budget: the per-group checks still run.
    }
  }
}

export async function inputPeer(ctx: Ctx, marked: number): Promise<tl.TypeInputPeer | null> {
  if (ctx.deny.isMarked(marked)) return null
  return ctx.tg.storage.peers.getById(marked, false)
}

async function probeBasicGroup(ctx: Ctx, rawId: number): Promise<Membership> {
  const res = (await ctx.tg.call({ _: 'messages.getFullChat', chatId: rawId })) as unknown as FullChatProbe
  return res.status
}

async function probeSupergroup(ctx: Ctx, marked: number): Promise<Membership> {
  const peer = await inputPeer(ctx, marked)
  if (!peer || peer._ !== 'inputPeerChannel') return 'unknown'
  const channel: tl.RawInputChannel = { _: 'inputChannel', channelId: peer.channelId, accessHash: peer.accessHash }
  const { users, missingHash } = probeUsers(ctx)
  for (const user of users) {
    try {
      await ctx.tg.call({
        _: 'channels.getParticipant',
        channel,
        participant: { _: 'inputPeerUser', userId: user.userId, accessHash: user.accessHash },
      })
      // Success means the denied user is a member. The guard has
      // already added the channel to the deny set.
      return 'denied'
    } catch (err) {
      if (isRpc(err, 'USER_NOT_PARTICIPANT')) continue
      if (err instanceof ToolError) throw err
      return 'unknown'
    }
  }
  return missingHash ? 'unknown' : 'clean'
}

/**
 * Decides whether a chat may be shown. DMs are clean unless the user is
 * denied. Groups use the 24 h cache, then a live probe.
 */
export async function verifyChat(
  ctx: Ctx,
  marked: number,
  options: { fresh?: boolean; allowVouch?: boolean } = {},
): Promise<Verdict> {
  if (ctx.deny.isMarked(marked)) return 'denied'
  const [kind, rawId] = parseMarked(marked)
  if (kind === 'user') return 'clean'

  let verdict: Membership | null = options.fresh ? null : ctx.state.membership(marked, ctx.now())
  if (verdict === null) {
    try {
      verdict = kind === 'chat' ? await probeBasicGroup(ctx, rawId) : await probeSupergroup(ctx, marked)
    } catch (err) {
      if (err instanceof ToolError && err.code === 'budget') return 'budget'
      if (err instanceof ToolError) throw err
      verdict = 'unknown'
    }
    ctx.state.setMembership(marked, verdict, ctx.now())
  }
  if (ctx.deny.isMarked(marked)) return 'denied'
  if (verdict === 'unknown' && options.allowVouch !== false && ctx.denylist.allowChats.includes(marked)) return 'clean'
  return verdict
}
