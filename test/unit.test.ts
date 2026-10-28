import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Long } from '@mtcute/core'
import { describe, expect, it } from 'vitest'
import { DenySet } from '../src/deny-set.js'
import { ToolError } from '../src/errors.js'
import { denyGuard } from '../src/guard.js'
import { InstanceLock } from '../src/lock.js'
import { assertClean, redactStrings } from '../src/output.js'
import { DeniedContentError, HIDDEN, discover, redactText, scrub } from '../src/scrub.js'
import { openSession } from '../src/client.js'
import { prepare } from '../src/run.js'
import { StateStore, WORK_INVITE_WINDOW_MS } from '../src/state.js'
import { runSync } from '../src/sync.js'
import { ALICE, DENIED, DENIED_GROUP, DENIED_SUPER, REACT_SUPER, SERVICE_GROUP, markChannel, markChat } from './fake-telegram.js'
import { loggedInEnv } from './helpers.js'

const D = 6660666
const deny = () =>
  new DenySet({
    version: 1,
    users: [{ id: D, accessHash: '1', redact: ['Jane Doe', 'janedoe'] }],
    chats: [markChat(4440444)],
    allowChats: [],
  })

const peerUser = (userId: number) => ({ _: 'peerUser', userId })
const peerChat = (chatId: number) => ({ _: 'peerChat', chatId })
const msg = (extra: Record<string, unknown>): Record<string, any> => ({ _: 'message', id: 1, date: 1, message: 'hi', peerId: peerUser(ALICE), ...extra })

describe('scrub', () => {
  it('always denies the service account 777000', () => {
    const d = new DenySet({ version: 1, users: [], chats: [], allowChats: [] })
    expect(d.isUser(777000)).toBe(true)
  })

  it('drops denied users and chats from lists', () => {
    const d = deny()
    const res = scrub(
      {
        _: 'messages.messages',
        users: [{ _: 'user', id: ALICE }, { _: 'user', id: D }],
        chats: [{ _: 'chat', id: 4440444 }, { _: 'chat', id: 3330333 }],
        messages: [msg({}), msg({ peerId: peerUser(D) }), msg({ peerId: peerChat(4440444) })],
      },
      d,
    )
    expect(res.users.map((u: any) => u.id)).toEqual([ALICE])
    expect(res.chats.map((c: any) => c.id)).toEqual([3330333])
    expect(res.messages.length).toBe(1)
  })

  it('drops forwards from denied users and name-only forwards matching a term', () => {
    const d = deny()
    const res = scrub(
      {
        messages: [
          msg({ fwdFrom: { _: 'messageFwdHeader', fromId: peerUser(D), date: 1 } }),
          msg({ fwdFrom: { _: 'messageFwdHeader', fromName: 'Jane Doe', date: 1 } }),
          msg({ replyTo: { _: 'messageReplyHeader', replyFrom: { _: 'messageFwdHeader', fromName: 'JANE DOE' } } }),
          msg({ replyTo: { _: 'messageReplyHeader', replyToPeerId: peerUser(D) } }),
          msg({ id: 2 }),
        ],
      },
      d,
    )
    expect(res.messages.map((m: any) => m.id)).toEqual([2])
  })

  it('hides the text under a mention of a denied user', () => {
    const d = deny()
    const res = scrub(
      {
        messages: [
          msg({ message: 'ask Jan now', entities: [{ _: 'messageEntityMentionName', offset: 4, length: 3, userId: D }] }),
          msg({ message: 'see her', entities: [{ _: 'messageEntityTextUrl', offset: 4, length: 3, url: `tg://user?id=${D}` }] }),
        ],
      },
      d,
    )
    expect(res.messages.map((m: any) => m.message)).toEqual([`ask ${HIDDEN} now`, `see ${HIDDEN}`])
    // Entities are not kept at all.
    expect(res.messages[0].entities).toBeUndefined()
  })

  it('drops service messages that name a denied user', () => {
    const d = deny()
    const res = scrub(
      {
        messages: [
          { _: 'messageService', id: 5, peerId: peerChat(3330333), date: 1, action: { _: 'messageActionChatAddUser', users: [D] } },
          { _: 'messageService', id: 6, peerId: peerChat(3330333), date: 1, action: { _: 'messageActionChatDeleteUser', userId: D } },
        ],
      },
      d,
    )
    expect(res.messages).toEqual([])
  })

  it('keeps only whitelisted message fields and reduces media to its type', () => {
    const res = scrub({ messages: [msg({ media: { _: 'messageMediaPhoto', photo: { id: 1 } }, reactions: {}, restrictionReason: [] })] }, deny())
    expect(Object.keys(res.messages[0]).sort()).toEqual(['_', 'date', 'id', 'media', 'message', 'peerId'])
    expect(res.messages[0].media).toEqual({ _: 'messageMediaPhoto' })
  })

  it('throws when the whole response is denied', () => {
    expect(() => scrub({ _: 'user', id: D }, deny())).toThrow(DeniedContentError)
  })

  it('leaves Long values and bytes untouched', () => {
    const hash = Long.fromNumber(42)
    const bytes = new Uint8Array([1, 2])
    const res = scrub({ users: [{ _: 'user', id: ALICE, accessHash: hash, photo: bytes }] }, deny())
    expect(res.users[0].accessHash).toBe(hash)
    expect(res.users[0].photo).toBe(bytes)
  })
})

describe('discover', () => {
  const group = peerChat(3330333)
  it('marks a group denied when a denied user posts, reacts, replies or is added', () => {
    const cases = [
      msg({ peerId: group, fromId: peerUser(D) }),
      msg({ peerId: group, reactions: { recentReactions: [{ peerId: peerUser(D) }] } }),
      msg({ peerId: group, replies: { recentRepliers: [peerUser(D)] } }),
      { _: 'messageService', id: 2, peerId: group, date: 1, action: { _: 'messageActionChatJoinedByLink', inviterId: D } },
    ]
    for (const m of cases) {
      const d = deny()
      discover({ messages: [m] }, d)
      expect(d.isChat(markChat(3330333))).toBe(true)
    }
  })

  it('does not mark a DM or a clean group', () => {
    const d = deny()
    discover({ messages: [msg({ peerId: group, fromId: peerUser(ALICE) }), msg({})] }, d)
    expect(d.chats.size).toBe(1)
  })
})

describe('redaction and final check', () => {
  it('redacts ids and terms in text, case-insensitive, whole numbers only', () => {
    const d = deny()
    expect(redactText(`jane doe (${D}) and 16660666`, d)).toBe(`${HIDDEN} (${HIDDEN}) and 16660666`)
    expect(redactText('group 4440444 and -4440444', d)).toBe(`group ${HIDDEN} and -${HIDDEN}`)
  })

  it('refuses output that still names a denied id or term', () => {
    const d = deny()
    expect(() => assertClean({ senderId: String(D) }, d)).toThrow(DeniedContentError)
    expect(() => assertClean({ chatId: -4440444 }, d)).toThrow(DeniedContentError)
    expect(() => assertClean({ title: 'JaneDoe fans' }, d)).toThrow(DeniedContentError)
    expect(() => assertClean({ [String(D)]: 1 }, d)).toThrow(DeniedContentError)
    // Message ids and counts may equal an id by chance.
    expect(() => assertClean({ id: D, unreadCount: D }, d)).not.toThrow()
    expect(() => assertClean(redactStrings({ text: `hi ${D}` }, d), d)).not.toThrow()
  })
})

describe('guard', () => {
  const run = async (mode: Parameters<typeof denyGuard>[0]['mode'], request: Record<string, unknown>, extra = {}) => {
    const d = deny()
    let called = false
    const mw = denyGuard({ deny: d, mode, readOnly: false, allowSend: false, ...extra })
    const res = await mw({ request } as never, async () => {
      called = true
      return { _: 'boolTrue' }
    })
    return { res, called, d }
  }
  const code = async (p: Promise<unknown>) => {
    try {
      await p
      return 'ok'
    } catch (e) {
      return e instanceof ToolError ? e.code : String(e)
    }
  }

  it('allows only listed methods per mode', async () => {
    expect(await code(run('sync', { _: 'messages.sendMessage', peer: { _: 'inputPeerSelf' } }))).toBe('method_blocked')
    expect(await code(run('read', { _: 'messages.getDialogs' }))).toBe('method_blocked')
    expect(await code(run('sync', { _: 'account.updateProfile' }))).toBe('method_blocked')
    expect(await code(run('sync', { _: 'updates.getDifference' }))).toBe('method_blocked')
    expect(await code(run('sync', { _: 'invokeWithLayer', query: {} }))).toBe('method_blocked')
    expect(await code(run('whoami', { _: 'users.getUsers', id: [{ _: 'inputUser', userId: ALICE }] }))).toBe('method_blocked')
    expect(await code(run('whoami', { _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }))).toBe('ok')
  })

  it('blocks writes in read-only mode and sends unless allowed', async () => {
    const draft = { _: 'messages.saveDraft', peer: { _: 'inputPeerUser', userId: ALICE }, message: 'x' }
    expect(await code(run('draft', draft, { readOnly: true }))).toBe('read_only')
    expect(await code(run('draft', draft))).toBe('ok')
    const send = { _: 'messages.sendMessage', peer: { _: 'inputPeerUser', userId: ALICE }, message: 'x' }
    expect(await code(run('send', send))).toBe('send_disabled')
    expect(await code(run('send', send, { allowSend: true }))).toBe('ok')
  })

  it('refuses any request that names a denied peer, before the network', async () => {
    const reqs = [
      { _: 'messages.getHistory', peer: { _: 'inputPeerUser', userId: D } },
      { _: 'messages.getHistory', peer: { _: 'inputPeerChat', chatId: 4440444 } },
      { _: 'messages.getDialogs', offsetPeer: { _: 'inputPeerUser', userId: D } },
    ]
    for (const r of reqs) {
      const out = run('sync', r)
      expect(await code(out)).toBe('chat_unavailable')
    }
  })

  it('lets probes name a denied user only in the probed field', async () => {
    const target = { _: 'inputUser', userId: D, accessHash: Long.ONE }
    expect(await code(run('sync', { _: 'messages.getCommonChats', userId: target, maxId: 0, limit: 100 }))).toBe('ok')
    expect(await code(run('sync', { _: 'messages.getCommonChats', userId: { _: 'inputUser', userId: ALICE }, maxId: 0 }))).toBe(
      'method_blocked',
    )
    const channel = { _: 'inputChannel', channelId: 5550555, accessHash: Long.ONE }
    const participant = { _: 'inputPeerUser', userId: D, accessHash: Long.ONE }
    expect(await code(run('sync', { _: 'channels.getParticipant', channel, participant }))).toBe('ok')
    expect(await code(run('sync', { _: 'channels.getParticipant', channel, participant: { _: 'inputPeerUser', userId: ALICE } }))).toBe(
      'method_blocked',
    )
  })

  it('returns a stub for a successful participant probe and denies the channel', async () => {
    const channel = { _: 'inputChannel', channelId: 5550555, accessHash: Long.ONE }
    const participant = { _: 'inputPeerUser', userId: D, accessHash: Long.ONE }
    const { res, d } = await run('sync', { _: 'channels.getParticipant', channel, participant })
    expect(res).toEqual({ _: 'tgi.participant' })
    expect(d.isChat(markChannel(5550555))).toBe(true)
  })
})

describe('lock', () => {
  it('allows one holder at a time', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tgi-lock-')), 'lock')
    const a = InstanceLock.acquire(file, 0)
    expect(() => InstanceLock.acquire(file, 0)).toThrow(ToolError)
    a.release()
    InstanceLock.acquire(file, 0).release()
  })
})

describe('state', () => {
  it('counts work invites in a rolling 23-hour window', () => {
    const state = new StateStore(join(mkdtempSync(join(tmpdir(), 'tgi-state-')), 'state.json'))
    const now = Date.now()
    state.data.workInvites = [now - WORK_INVITE_WINDOW_MS, now - WORK_INVITE_WINDOW_MS + 1]

    expect(state.workInvitesToday(now)).toBe(1)
  })
})

describe('in-memory peer cache', () => {
  it('never holds a peer known to be denied before the run', async () => {
    const env = await loggedInEnv()
    const { config, denylist, state, deny: d } = prepare(env.paths, env.trust)
    const session = await openSession({
      paths: env.paths,
      config,
      deny: d,
      state,
      mode: 'sync',
      flood: env.flood,
      fakeTelegram: env.fake.middleware(),
      logSink: () => {},
    })
    try {
      const ctx = { tg: session.tg, deny: d, state, config, denylist, selfId: session.selfId!, now: () => env.clock.t }
      await runSync(ctx, {})
      // Known up front (denylist) or found by the common-chats probe before
      // any dialog was fetched: never cached, not even in memory.
      for (const id of [DENIED, markChat(DENIED_GROUP), markChannel(DENIED_SUPER)]) {
        expect(await session.tg.storage.peers.getCompleteById(id)).toBeNull()
        expect(await session.tg.storage.peers.getById(id)).toBeNull()
      }
      expect(await session.tg.storage.peers.getById(ALICE)).not.toBeNull()
      expect(session.storage.stats.refusedPeers).toBe(0)
      // Found only from their messages: in memory until the run ends,
      // removed from the file at close (see the e2e session-file test).
      expect(d.isMarked(markChannel(REACT_SUPER))).toBe(true)
      expect(d.isMarked(markChat(SERVICE_GROUP))).toBe(true)
    } finally {
      await session.close()
    }
  })
})
