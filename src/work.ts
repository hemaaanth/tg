import { Long, tl } from '@mtcute/core'
import { ToolError } from './errors.js'
import { userName } from './format.js'
import type { FullChatProbe } from './guard.js'
import { parseMarked } from './ids.js'
import { DAY_MS } from './state.js'
import { loadDialogs } from './sync.js'
import { inputPeer, refreshCommonChats, verifyChat, type Ctx } from './verify.js'

type Target = { id: number; accessHash: string; username: string; name: string | null }
type Presence = 'present' | 'absent' | 'unknown'

function inputUser(target: Target): tl.RawInputUser {
  return { _: 'inputUser', userId: target.id, accessHash: Long.fromString(target.accessHash) }
}

/** The configured work account and title word. Both must be set, or the work verbs are off. */
function workConfig(ctx: Ctx): { username: string; title: RegExp } {
  const { workUser, workTitle } = ctx.config
  if (!workUser || !workTitle) throw new ToolError('work_unset')
  const word = workTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return { username: workUser, title: new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'iu') }
}

async function resolveTarget(ctx: Ctx, username: string): Promise<Target> {
  // A pinned identity counts only for the account the config still names.
  const saved = ctx.state.data.workUser
  if (saved && saved.username === username) return saved
  const res = (await ctx.tg.call({ _: 'contacts.resolveUsername', username })) as unknown as {
    peer?: unknown
    users?: tl.TypeUser[]
  }
  const user = res.users?.find((u): u is tl.RawUser => u._ === 'user' && u.username?.toLowerCase() === username)
  if (!user || user.bot || user.deleted || !user.accessHash) throw new ToolError('chat_unavailable')
  const target = {
    id: user.id,
    accessHash: user.accessHash.toString(),
    username,
    name: userName(user),
  }
  ctx.state.data.workUser = target
  return target
}

async function basicPresence(ctx: Ctx, rawId: number, target: Target): Promise<{ safe: boolean; presence: Presence }> {
  const res = (await ctx.tg.call({ _: 'messages.getFullChat', chatId: rawId })) as unknown as FullChatProbe
  if (res.status !== 'clean') return { safe: false, presence: 'unknown' }
  return { safe: true, presence: res.memberIds?.includes(target.id) ? 'present' : 'absent' }
}

async function channelPresence(ctx: Ctx, marked: number, target: Target): Promise<Presence> {
  const peer = await inputPeer(ctx, marked)
  if (!peer || peer._ !== 'inputPeerChannel') return 'unknown'
  try {
    await ctx.tg.call({
      _: 'channels.getParticipant',
      channel: { _: 'inputChannel', channelId: peer.channelId, accessHash: peer.accessHash },
      participant: { _: 'inputPeerUser', userId: target.id, accessHash: Long.fromString(target.accessHash) },
    })
    return 'present'
  } catch (err) {
    if (tl.RpcError.is(err) && err.text === 'USER_NOT_PARTICIPANT') return 'absent'
    if (err instanceof ToolError) throw err
    return 'unknown'
  }
}

async function exactPresence(
  ctx: Ctx,
  marked: number,
  target: Target,
  freshSafety = true,
): Promise<{ safe: boolean; presence: Presence }> {
  const [kind, rawId] = parseMarked(marked)
  if (kind === 'chat') return basicPresence(ctx, rawId, target)
  if (kind !== 'channel') return { safe: false, presence: 'unknown' }
  const verdict = await verifyChat(ctx, marked, freshSafety ? { fresh: true, allowVouch: false } : {})
  if (verdict === 'budget') throw new ToolError('budget')
  if (verdict !== 'clean') return { safe: false, presence: 'unknown' }
  return { safe: true, presence: await channelPresence(ctx, marked, target) }
}

export async function runWorkAudit(ctx: Ctx): Promise<object> {
  const work = workConfig(ctx)
  const target = await resolveTarget(ctx, work.username)
  await refreshCommonChats(ctx)
  const { candidates, complete: dialogsComplete, stops: dialogStops } = await loadDialogs(ctx, [0, 1], Number.POSITIVE_INFINITY)
  const previous = ctx.state.data.workChats
  // A new audit replaces the prior allowlist, so renamed or missing chats
  // cannot remain invite-eligible from an older scan.
  ctx.state.data.workChats = {}
  const items: object[] = []
  let complete = dialogsComplete
  for (const chat of candidates) {
    if (chat.type === 'user' || !work.title.test(chat.title)) continue
    const key = String(chat.marked)
    const cached = previous[key]
    let checked: { safe: boolean; presence: Presence } = {
      safe: Boolean(cached?.serviceUser && cached.title === chat.title && ctx.now() - cached.seenAt < DAY_MS),
      presence: cached?.serviceUser ?? 'unknown',
    }
    if (!checked.safe) {
      try {
        checked = await exactPresence(ctx, chat.marked, target, false)
      } catch (err) {
        if (err instanceof ToolError && err.code === 'budget') {
          complete = false
          break
        }
        throw err
      }
    }
    if (!checked.safe || ctx.deny.isMarked(chat.marked)) continue
    const now = ctx.now()
    const lastActivityDate = (chat.top as { date?: number } | undefined)?.date
    ctx.state.data.known[key] = { kind: parseMarked(chat.marked)[0], lastInboundId: 0, seenAt: now }
    ctx.state.data.workChats[key] = { title: chat.title, seenAt: now, serviceUser: checked.presence }
    items.push({
      chatId: key,
      chatType: chat.type,
      title: chat.title,
      username: chat.username,
      folder: chat.folderId === 1 ? 'archive' : 'main',
      canInvite: chat.canInvite,
      serviceUser: checked.presence,
      lastActivityAt: typeof lastActivityDate === 'number' ? new Date(lastActivityDate * 1000).toISOString() : null,
    })
  }
  return {
    ok: true,
    verb: 'work-audit',
    complete,
    scannedAt: new Date(ctx.now()).toISOString(),
    target: { userId: String(target.id), username: target.username, name: target.name },
    dialogStops,
    items,
  }
}

export async function runInviteWorkUser(ctx: Ctx, marked: number): Promise<object> {
  const work = workConfig(ctx)
  if (ctx.config.readOnly) throw new ToolError('read_only')
  if (!ctx.config.allowWorkInvite) throw new ToolError('invite_disabled')
  const audited = ctx.state.data.workChats[String(marked)]
  if (!audited || ctx.now() - audited.seenAt >= DAY_MS) throw new ToolError('chat_unavailable')
  const count = ctx.state.workInvitesToday(ctx.now())
  if (count >= ctx.config.dailyWorkInviteCap) throw new ToolError('invite_cap')

  const target = await resolveTarget(ctx, work.username)
  const checked = await exactPresence(ctx, marked, target)
  if (!checked.safe || checked.presence === 'unknown') throw new ToolError('chat_unavailable')
  if (checked.presence === 'present') {
    audited.serviceUser = 'present'
    audited.seenAt = ctx.now()
    return { ok: true, verb: 'invite-work-user', chatId: String(marked), status: 'already_present' }
  }

  // Count before the RPC. An ambiguous network result must consume the slot.
  ctx.state.data.workInvites.push(ctx.now())
  ctx.state.save()
  const [kind, rawId] = parseMarked(marked)
  const user = inputUser(target)
  if (kind === 'chat') {
    await ctx.tg.call({ _: 'messages.addChatUser', chatId: rawId, userId: user, fwdLimit: 0 })
  } else if (kind === 'channel') {
    const peer = await inputPeer(ctx, marked)
    if (!peer || peer._ !== 'inputPeerChannel') throw new ToolError('chat_unavailable')
    await ctx.tg.call({
      _: 'channels.inviteToChannel',
      channel: { _: 'inputChannel', channelId: peer.channelId, accessHash: peer.accessHash },
      users: [user],
    })
  } else {
    throw new ToolError('chat_unavailable')
  }
  audited.serviceUser = 'present'
  audited.seenAt = ctx.now()
  return {
    ok: true,
    verb: 'invite-work-user',
    chatId: String(marked),
    status: 'invited',
    invitationsToday: count + 1,
    dailyCap: ctx.config.dailyWorkInviteCap,
  }
}
