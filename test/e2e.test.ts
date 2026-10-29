import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  BROADCAST,
  CLEAN_GROUP,
  CLEAN_SUPER,
  DENIED,
  DENIED_GROUP,
  DENIED_NO_HASH,
  DENIED_SUPER,
  HIDDEN_SUPER,
  REACT_SUPER,
  SERVICE,
  SERVICE_GROUP,
  SELF,
  WORK_USER,
  markChannel,
  markChat,
} from './fake-telegram.js'
import { admin, baseDenylist, cli, loggedInEnv, makeEnv, sessionBytes, stateText, writeJson } from './helpers.js'

const DENIED_IDS = [
  DENIED,
  SERVICE,
  markChat(DENIED_GROUP),
  markChat(SERVICE_GROUP),
  markChannel(DENIED_SUPER),
  markChannel(REACT_SUPER),
]

/** Every string an agent could see must be free of denied content. */
function expectNoCanary(text: string): void {
  expect(text).not.toMatch(/canary/i)
  expect(text).not.toMatch(/mallory/i)
  for (const id of DENIED_IDS) {
    expect(text).not.toContain(String(id))
    expect(text).not.toContain(String(Math.abs(id)))
  }
  for (const raw of [DENIED_GROUP, SERVICE_GROUP, DENIED_SUPER, REACT_SUPER]) expect(text).not.toContain(String(raw))
}

function sessionRows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const peers = db.prepare('select id from peers').all().map((r) => Number(r.id))
    const refs = db.prepare('select peer_id, chat_id from message_refs').all()
    return { peers, refs }
  } finally {
    db.close()
  }
}

function allStateFiles(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f)).toString('latin1'))
    .join('\n')
}

const WORK = { workUser: 'northwindservice', workTitle: 'northwind' }

describe('work chat audit and invitation', () => {
  it('is off until the config names the work account and title word', async () => {
    const env = await loggedInEnv({ config: { allowWorkInvite: true, dailyWorkInviteCap: 2 } })
    const audit = await cli(env, 'work-audit', '--json')
    expect(audit.code).toBe(4)
    expect(audit.json.error.code).toBe('work_unset')
    const invite = await cli(env, 'invite-work-user', String(markChat(CLEAN_GROUP)), '--json')
    expect(invite.json.error.code).toBe('work_unset')
    expect(env.fake.methods()).not.toContain('contacts.resolveUsername')
  })

  it('refuses a bad work account or title word in the config', async () => {
    for (const config of [{ workUser: 'x' }, { workUser: 'has space' }, { workTitle: '' }, { workTitle: 'a(b' }, { workTitle: 7 }]) {
      const env = makeEnv({ config })
      expect((await cli(env, 'status')).json.error.code).toBe('config_invalid')
    }
  })

  it('finds title-matched groups in both folders and checks the fixed human member', async () => {
    const env = await loggedInEnv({ config: WORK })
    const superDialog = env.fake.dialogs.find((d) => d.peer === markChannel(CLEAN_SUPER))!
    superDialog.folder = 1

    const r = await cli(env, 'work-audit', '--json')
    expect(r.code).toBe(0)
    expect(r.json.complete).toBe(true)
    expect(r.json.target).toEqual({ userId: String(WORK_USER), username: 'northwindservice', name: 'Northwind Service' })
    expect(r.json.items).toEqual([
      expect.objectContaining({
        chatId: String(markChat(CLEAN_GROUP)), folder: 'main', serviceUser: 'present',
        lastActivityAt: new Date(1_750_000_012 * 1000).toISOString(),
      }),
      expect.objectContaining({
        chatId: String(markChannel(CLEAN_SUPER)), folder: 'archive', serviceUser: 'absent',
        lastActivityAt: new Date(1_750_000_017 * 1000).toISOString(),
      }),
    ])
    expect(r.raw).not.toContain(String(DENIED))
    expect(env.fake.methods().filter((m) => m === 'contacts.resolveUsername')).toHaveLength(1)

    await cli(env, 'work-audit', '--json')
    expect(env.fake.methods().filter((m) => m === 'contacts.resolveUsername')).toHaveLength(1)
  })

  it('keeps invitations disabled by default', async () => {
    const env = await loggedInEnv({ config: WORK })
    await cli(env, 'work-audit', '--json')
    const r = await cli(env, 'invite-work-user', String(markChannel(CLEAN_SUPER)), '--json')
    expect(r.code).toBe(4)
    expect(r.json.error.code).toBe('invite_disabled')
    expect(env.fake.invited).toEqual([])
  })

  it('returns verified partial results when its membership budget is exhausted', async () => {
    const env = await loggedInEnv({ config: WORK })
    env.flood.budgets = { 'channels.getParticipant': { max: 0, minIntervalMs: 0 } }
    const r = await cli(env, 'work-audit', '--json')
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, complete: false, items: [] })
  })

  it('reuses recent audit results without another membership call', async () => {
    const env = await loggedInEnv({ config: WORK })
    env.fake.chats.get(markChannel(CLEAN_SUPER))!.title = 'Not a work chat'
    const first = await cli(env, 'work-audit', '--json')
    expect(first.json.complete).toBe(true)
    env.fake.calls.length = 0
    env.flood.budgets = { 'messages.getFullChat': { max: 0, minIntervalMs: 0 } }
    const second = await cli(env, 'work-audit', '--json')
    expect(second.json).toMatchObject({ complete: true, items: [expect.objectContaining({ serviceUser: 'present' })] })
    expect(env.fake.methods()).not.toContain('messages.getFullChat')
  })

  it('stops safely if Telegram repeats a dialog cursor', async () => {
    const env = await loggedInEnv({ config: WORK })
    env.fake.repeatDialogsPage = true
    env.fake.dialogs = Array.from({ length: 101 }, () => ({
      peer: ALICE, folder: 0 as const, unread: 1, readInboxMaxId: 0,
    }))
    const r = await cli(env, 'work-audit', '--json')
    expect(r.json.complete).toBe(false)
    expect(r.json.dialogStops).toEqual([expect.objectContaining({ folderId: 0, reason: 'repeated_cursor' })])
    expect(env.fake.methods().filter((method) => method === 'messages.getDialogs')).toHaveLength(3)
  })

  it('continues through short partial dialog pages', async () => {
    const env = await loggedInEnv({ config: WORK })
    env.fake.dialogPageCap = 3
    const r = await cli(env, 'work-audit', '--json')
    expect(r.json.complete).toBe(true)
    expect(r.json.items).toHaveLength(2)
    expect(env.fake.methods().filter((method) => method === 'messages.getDialogs')).toHaveLength(6)
  })

  it('continues when a page boundary dialog has no returned top message', async () => {
    const env = await loggedInEnv({ config: WORK })
    env.fake.dialogPageCap = 3
    env.fake.omitTopFor.add(markChannel(HIDDEN_SUPER))
    const r = await cli(env, 'work-audit', '--json')
    expect(r.json.complete).toBe(true)
    expect(r.json.items).toHaveLength(2)
    expect(env.fake.methods().filter((method) => method === 'messages.getDialogs')).toHaveLength(6)
  })

  it('finishes when Telegram overstates the count then returns an empty slice', async () => {
    const env = await loggedInEnv({ config: WORK })
    env.fake.dialogPageCap = 3
    env.fake.dialogCountOverstatement = 10
    const r = await cli(env, 'work-audit', '--json')
    expect(r.json.complete).toBe(true)
    expect(r.json.dialogStops).toEqual([])
    expect(r.json.items).toHaveLength(2)
    expect(env.fake.methods().filter((method) => method === 'messages.getDialogs')).toHaveLength(7)
  })

  it('invites only the pinned account to a recently audited chat', async () => {
    const env = await loggedInEnv({ config: { ...WORK, allowWorkInvite: true, dailyWorkInviteCap: 2 } })
    await cli(env, 'work-audit', '--json')

    const r = await cli(env, 'invite-work-user', String(markChannel(CLEAN_SUPER)), '--json')
    expect(r.code).toBe(0)
    expect(r.json.status).toBe('invited')
    expect(env.fake.invited).toEqual([{ peer: markChannel(CLEAN_SUPER), user: WORK_USER, fwdLimit: null }])
    const audited = await cli(env, 'work-audit', '--json')
    expect(audited.json.items.find((item: { chatId: string }) => item.chatId === String(markChannel(CLEAN_SUPER))))
      .toMatchObject({ serviceUser: 'present' })

    const present = await cli(env, 'invite-work-user', String(markChat(CLEAN_GROUP)), '--json')
    expect(present.json.status).toBe('already_present')
    expect(env.fake.invited).toHaveLength(1)
  })

  it('rejects chats that were not returned by the work audit', async () => {
    const env = await loggedInEnv({ config: { ...WORK, allowWorkInvite: true, dailyWorkInviteCap: 2 } })
    await cli(env, 'work-audit', '--json')
    const r = await cli(env, 'invite-work-user', String(markChannel(HIDDEN_SUPER)), '--json')
    expect(r.code).toBe(4)
    expect(r.json.error.code).toBe('chat_unavailable')
    expect(env.fake.invited).toEqual([])
  })

  it('uses zero history for a basic-group invite and enforces the daily cap', async () => {
    const env = await loggedInEnv({ config: { ...WORK, allowWorkInvite: true, dailyWorkInviteCap: 1 } })
    env.fake.chats.get(markChat(CLEAN_GROUP))!.members = [SELF, ALICE, BOB]
    await cli(env, 'work-audit', '--json')

    const first = await cli(env, 'invite-work-user', String(markChat(CLEAN_GROUP)), '--json')
    expect(first.json.status).toBe('invited')
    expect(env.fake.invited).toEqual([{ peer: markChat(CLEAN_GROUP), user: WORK_USER, fwdLimit: 0 }])

    const second = await cli(env, 'invite-work-user', String(markChannel(CLEAN_SUPER)), '--json')
    expect(second.code).toBe(4)
    expect(second.json.error.code).toBe('invite_cap')
  })

  it('shares a three-minute throttle across basic-group and supergroup invites', async () => {
    const env = await loggedInEnv({ config: { ...WORK, allowWorkInvite: true, dailyWorkInviteCap: 2 } })
    env.fake.chats.get(markChat(CLEAN_GROUP))!.members = [SELF, ALICE, BOB]
    await cli(env, 'work-audit', '--json')

    expect((await cli(env, 'invite-work-user', String(markChat(CLEAN_GROUP)), '--json')).json.status).toBe('invited')
    const firstAt = env.clock.t
    expect((await cli(env, 'invite-work-user', String(markChannel(CLEAN_SUPER)), '--json')).json.status).toBe('invited')
    expect(env.clock.t - firstAt).toBeGreaterThanOrEqual(180_000)
  })

  it('allows a daily work invite cap of ten but not eleven', async () => {
    const ten = await loggedInEnv({ config: { ...WORK, allowWorkInvite: true, dailyWorkInviteCap: 10 } })
    expect((await cli(ten, 'status')).json.dailyWorkInviteCap).toBe(10)
    const eleven = makeEnv({ config: { ...WORK, allowWorkInvite: true, dailyWorkInviteCap: 11 } })
    expect((await cli(eleven, 'status')).json.error.code).toBe('config_invalid')
  })
})

describe('sync', () => {
  it('lists clean unread chats and nothing denied', async () => {
    const env = await loggedInEnv()
    const r = await cli(env, 'sync', '--json')
    expect(r.code).toBe(0)
    expect(r.json.ok).toBe(true)
    expect(r.json.complete).toBe(true)
    const ids = r.json.items.map((i: { chatId: string }) => Number(i.chatId)).sort()
    expect(ids).toEqual([ALICE, BOB, markChat(CLEAN_GROUP), markChannel(CLEAN_SUPER)].sort())
    // Hidden member list: unknown, so hidden. Broadcast: out of scope.
    expect(ids).not.toContain(markChannel(HIDDEN_SUPER))
    expect(ids).not.toContain(markChannel(BROADCAST))

    const alice = r.json.items.find((i: { chatId: string }) => i.chatId === String(ALICE))
    const texts = alice.messages.map((m: { text: string }) => m.text)
    expect(texts).toEqual([
      'hello from Alice',
      'ask [hidden] about it',
      '[hidden] said hi',
      'their id is [hidden]',
      'last clean message',
    ])
    expectNoCanary(r.raw)
  })

  it('keeps denied data out of the session file, state, cache and logs', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    const bytes = sessionBytes(env).toString('latin1')
    expect(bytes).not.toMatch(/canary/i)
    expect(bytes).not.toMatch(/mallory/i)
    const { peers, refs } = sessionRows(env.paths.sessionFile)
    for (const id of DENIED_IDS) expect(peers).not.toContain(id)
    expect(refs).toEqual([])
    // Clean peers are cached normally.
    expect(peers).toContain(ALICE)
    // No leftover journal or temp files with content.
    expect(allStateFiles(env.paths.stateDir)).not.toMatch(/canary/i)
    // Logs: many lines at verbose level, none with details.
    for (const line of env.logs) {
      expect(line).toMatch(/^tg: mtcute \w+ \[[\w.-]+\] \(details withheld\)$/)
      expectNoCanary(line)
    }
  })

  it('never calls a method with a denied peer', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    for (const call of env.fake.calls) {
      if (call.method === 'messages.getCommonChats' || call.method === 'channels.getParticipant') continue
      expect(JSON.stringify(call.request, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
        String(DENIED),
      )
    }
    // No history was fetched for any denied chat.
    const historyPeers = env.fake.calls
      .filter((c) => c.method === 'messages.getHistory')
      .map((c) => JSON.stringify(c.request.peer))
    for (const p of historyPeers) {
      expect(p).not.toContain(String(DENIED_GROUP))
      expect(p).not.toContain(String(DENIED_SUPER))
    }
  })

  it('persists discovered denied groups and skips them next run', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    const state = JSON.parse(stateText(env))
    for (const id of [markChat(DENIED_GROUP), markChannel(DENIED_SUPER), markChat(SERVICE_GROUP), markChannel(REACT_SUPER)]) {
      expect(state.deniedChats).toContain(id)
    }
    env.fake.calls.length = 0
    env.clock.t += 60_000
    const r = await cli(env, 'sync', '--json')
    expect(r.code).toBe(0)
    // Membership is cached for 24 h: no probes the second time.
    expect(env.fake.methods()).not.toContain('channels.getParticipant')
    expect(env.fake.methods()).not.toContain('messages.getFullChat')
    expect(env.fake.methods()).not.toContain('messages.getCommonChats')
    const historyPeers = env.fake.calls.filter((c) => c.method === 'messages.getHistory').map((c) => JSON.stringify(c.request.peer))
    for (const p of historyPeers) {
      expect(p).not.toContain(String(REACT_SUPER))
      expect(p).not.toContain(String(SERVICE_GROUP))
    }
    expectNoCanary(r.raw)
  })

  it('finds denied groups by probing when common chats fail', async () => {
    const env = await loggedInEnv()
    env.fake.inject.set('messages.getCommonChats', ['USER_ID_INVALID'])
    const r = await cli(env, 'sync', '--json')
    expect(r.code).toBe(0)
    expect(env.fake.methods()).toContain('channels.getParticipant')
    expect(env.fake.methods()).toContain('messages.getFullChat')
    expectNoCanary(r.raw)
    const state = JSON.parse(stateText(env))
    expect(state.deniedChats).toContain(markChannel(DENIED_SUPER))
    expect(state.deniedChats).toContain(markChat(DENIED_GROUP))
  })

  it('hides supergroups when a denied user has no access hash, unless allowed', async () => {
    const withNoHash = (allow: number[]) => (f: Parameters<typeof baseDenylist>[0]) => {
      const list = baseDenylist(f, { allowChats: allow })
      list.users.push({ id: DENIED_NO_HASH, accessHash: null, redact: ['CANARY Nohash'] })
      return list
    }
    const env = await loggedInEnv({ denylist: withNoHash([]) })
    let r = await cli(env, 'sync', '--json')
    let ids = r.json.items.map((i: { chatId: string }) => Number(i.chatId))
    expect(ids).not.toContain(markChannel(CLEAN_SUPER))
    expect(ids).toContain(markChat(CLEAN_GROUP))

    writeJson(env.paths.denylistFile, withNoHash([markChannel(CLEAN_SUPER)])(env.fake))
    r = await cli(env, 'sync', '--json')
    ids = r.json.items.map((i: { chatId: string }) => Number(i.chatId))
    expect(ids).toContain(markChannel(CLEAN_SUPER))
    expectNoCanary(r.raw)
  })

  it('reports unchanged chats from the cursor without fetching history', async () => {
    const env = await loggedInEnv()
    const first = await cli(env, 'sync', '--json')
    env.fake.calls.length = 0
    env.clock.t += 60_000
    const second = await cli(env, 'sync', '--json', '--since', JSON.stringify(first.json.cursor))
    expect(second.json.items.every((i: { unchanged: boolean }) => i.unchanged)).toBe(true)
    expect(env.fake.methods()).not.toContain('messages.getHistory')
  })

  it('rejects a bad cursor', async () => {
    const env = await loggedInEnv()
    const r = await cli(env, 'sync', '--json', '--since', '{"x":1}')
    expect(r.code).toBe(2)
    expect(r.json.error.code).toBe('bad_args')
  })
})

describe('read', () => {
  it('reads a known clean chat', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    const r = await cli(env, 'read', String(markChat(CLEAN_GROUP)), '--limit', '10')
    expect(r.code).toBe(0)
    expect(r.json.messages.map((m: { text: string }) => m.text)).toEqual(['group hello', 'group reply'])
    expect(r.json.messages[0].sender).toBe('Alice Clean')
  })

  it('gives the same error for denied, unseen and unknown chats', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    env.fake.calls.length = 0
    for (const id of [DENIED, SERVICE, markChat(DENIED_GROUP), markChannel(HIDDEN_SUPER), 99999]) {
      const r = await cli(env, 'read', String(id))
      expect(r.code).toBe(4)
      expect(r.json.error.code).toBe('chat_unavailable')
      expectNoCanary(r.raw)
    }
    expect(env.fake.methods()).not.toContain('messages.getHistory')
  })
})

describe('chats', () => {
  it('lists clean chats in both folders and nothing denied', async () => {
    const env = await loggedInEnv()
    env.fake.dialogs.find((d) => d.peer === BOB)!.folder = 1
    const r = await cli(env, 'chats', '--folder', 'all', '--json')
    expect(r.code).toBe(0)
    expect(r.json.complete).toBe(true)
    const ids = r.json.items.map((i: { chatId: string }) => Number(i.chatId)).sort()
    expect(ids).toEqual([ALICE, BOB, markChat(CLEAN_GROUP), markChannel(CLEAN_SUPER)].sort())
    const bob = r.json.items.find((i: { chatId: string }) => i.chatId === String(BOB))
    expect(bob).toMatchObject({ folder: 'archive', chatType: 'user', title: 'Bob Clean', lastMessage: { text: 'Bob says hi' } })
    expectNoCanary(r.raw)

    const main = await cli(env, 'chats', '--json')
    expect(main.json.items.map((i: { chatId: string }) => Number(i.chatId))).not.toContain(BOB)
  })

  it('filters by title or username and makes read work without a sync', async () => {
    const env = await loggedInEnv()
    const r = await cli(env, 'chats', '--query', 'widget', '--json')
    expect(r.json.items.map((i: { title: string }) => i.title)).toEqual(['Northwind x Widget'])
    const byName = await cli(env, 'chats', '--query', 'ALICE', '--json')
    expect(byName.json.items.map((i: { chatId: string }) => Number(i.chatId))).toEqual([ALICE])
    const canary = await cli(env, 'chats', '--query', 'canary', '--json')
    expect(canary.json.items).toEqual([])

    const read = await cli(env, 'read', String(markChannel(CLEAN_SUPER)))
    expect(read.code).toBe(0)
    expect(read.json.messages.map((m: { text: string }) => m.text)).toEqual(['super hello', 'super reply'])
  })

  it('reads the recent history of a new group, so a denied user added there hides it', async () => {
    const env = await loggedInEnv()
    const r = await cli(env, 'chats', '--query', 'service', '--json')
    expect(r.json.items).toEqual([])
    const s = await cli(env, 'search', '--query', 'after add', '--json')
    expect(s.json.messages).toEqual([])
    expectNoCanary(r.raw + s.raw)
    // Known chats are not read again.
    await cli(env, 'chats', '--json')
    env.fake.calls.length = 0
    await cli(env, 'chats', '--json')
    expect(env.fake.methods()).not.toContain('messages.getHistory')
  })

  it('rejects a bad folder or limit', async () => {
    const env = await loggedInEnv()
    expect((await cli(env, 'chats', '--folder', 'saved')).json.error.code).toBe('bad_args')
    expect((await cli(env, 'chats', '--limit', '0')).json.error.code).toBe('bad_args')
  })
})

describe('resolve', () => {
  it('resolves a clean user in the chats item shape and makes read work', async () => {
    const env = await loggedInEnv()
    const r = await cli(env, 'resolve', '@Alice', '--json')
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, verb: 'resolve', complete: true, cooldown: null })
    expect(r.json.chat).toMatchObject({
      chatId: String(ALICE),
      chatType: 'user',
      title: 'Alice Clean',
      username: 'alice',
      isBot: false,
      folder: 'main',
      unreadCount: 0,
      lastMessage: { text: 'last clean message' },
    })
    expect(env.fake.methods().filter((m) => m === 'contacts.resolveUsername')).toHaveLength(1)
    expect(env.fake.methods()).not.toContain('messages.getDialogs')

    const read = await cli(env, 'read', String(ALICE), '--limit', '1')
    expect(read.code).toBe(0)
    expect(read.json.messages.map((m: { text: string }) => m.text)).toEqual(['last clean message'])
  })

  it('gives null for a denied or unknown username, and stores nothing about the denied user', async () => {
    const env = await loggedInEnv()
    for (const name of ['canarymal', 'CanaryMal', 'nobodyhere']) {
      const r = await cli(env, 'resolve', name, '--json')
      expect(r.code).toBe(0)
      expect(r.json).toEqual({ ok: true, verb: 'resolve', complete: true, cooldown: null, chat: null })
      expectNoCanary(r.raw)
    }
    expect(sessionRows(env.paths.sessionFile).peers).not.toContain(DENIED)
    expect(Object.keys(JSON.parse(stateText(env)).known)).toEqual([])
    expect((await cli(env, 'read', String(DENIED))).json.error.code).toBe('chat_unavailable')
  })

  it('gives a clean group, and null for a denied group, a group a denied user touched, or a broadcast channel', async () => {
    const env = await loggedInEnv()
    env.fake.chats.get(markChannel(CLEAN_SUPER))!.username = 'widgetgroup'
    env.fake.chats.get(markChannel(DENIED_SUPER))!.username = 'canarysuper'
    env.fake.chats.get(markChannel(REACT_SUPER))!.username = 'reactgroup'
    env.fake.chats.get(markChannel(BROADCAST))!.username = 'newsfeed'
    const clean = await cli(env, 'resolve', 'widgetgroup', '--json')
    expect(clean.json.chat).toMatchObject({
      chatId: String(markChannel(CLEAN_SUPER)),
      chatType: 'supergroup',
      title: 'Northwind x Widget',
      username: 'widgetgroup',
      lastMessage: { text: 'super reply' },
    })
    for (const name of ['canarysuper', 'reactgroup', 'newsfeed']) {
      const r = await cli(env, 'resolve', name, '--json')
      expect(r.code).toBe(0)
      expect(r.json.chat).toBeNull()
      expectNoCanary(r.raw)
    }
  })

  it('rejects a missing or malformed username before any lookup', async () => {
    const env = await loggedInEnv()
    for (const argv of [[], ['abc'], ['1alice'], ['al-ice'], ['alice', 'bob'], ['a'.repeat(33)]]) {
      const r = await cli(env, 'resolve', ...argv)
      expect(r.code).toBe(2)
      expect(r.json.error.code).toBe('bad_args')
    }
    expect(env.fake.methods()).not.toContain('contacts.resolveUsername')
  })
})

describe('chat', () => {
  it('gives a clean basic group by id without a sync, with folder and unread count', async () => {
    const env = await loggedInEnv()
    const r = await cli(env, 'chat', String(markChat(CLEAN_GROUP)), '--json')
    expect(r.code).toBe(0)
    expect(r.json).toEqual({
      ok: true,
      verb: 'chat',
      complete: true,
      cooldown: null,
      chat: expect.objectContaining({
        chatId: String(markChat(CLEAN_GROUP)),
        chatType: 'group',
        title: 'Northwind x Acme',
        username: null,
        isBot: false,
        folder: 'main',
        unreadCount: 2,
        lastMessage: expect.objectContaining({ text: 'group reply' }),
      }),
    })
    expect(env.fake.methods()).not.toContain('messages.getDialogs')
    const read = await cli(env, 'read', String(markChat(CLEAN_GROUP)), '--limit', '1')
    expect(read.json.messages.map((m: { text: string }) => m.text)).toEqual(['group reply'])
  })

  it('gives a clean user and supergroup once the session has their access hash', async () => {
    const env = await loggedInEnv()
    // Never seen: no access hash, so no lookup and null.
    for (const id of [ALICE, markChannel(CLEAN_SUPER)]) {
      const r = await cli(env, 'chat', String(id), '--json')
      expect(r.code).toBe(0)
      expect(r.json.chat).toBeNull()
    }
    expect(env.fake.methods()).not.toContain('messages.getPeerDialogs')

    await cli(env, 'sync', '--json')
    env.fake.dialogs.find((d) => d.peer === ALICE)!.folder = 1
    const alice = await cli(env, 'chat', String(ALICE), '--json')
    expect(alice.json.chat).toMatchObject({ chatId: String(ALICE), chatType: 'user', title: 'Alice Clean', username: 'alice', folder: 'archive', unreadCount: 7 })
    const sup = await cli(env, 'chat', String(markChannel(CLEAN_SUPER)), '--json')
    expect(sup.json.chat).toMatchObject({ chatType: 'supergroup', title: 'Northwind x Widget', lastMessage: { text: 'super reply' } })
  })

  it('gives null for denied users and groups, groups a denied user touched, broadcasts, and chats the account is not in', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    env.fake.chats.set(markChat(9990999), { id: 9990999, kind: 'chat', title: 'Not a member', members: [ALICE] })
    const ids = [
      DENIED,
      DENIED_NO_HASH,
      markChat(DENIED_GROUP),
      markChat(SERVICE_GROUP),
      markChannel(DENIED_SUPER),
      markChannel(REACT_SUPER),
      markChannel(BROADCAST),
      markChat(9990999),
      markChannel(9990998),
    ]
    for (const id of ids) {
      const r = await cli(env, 'chat', String(id), '--json')
      expect(r.code).toBe(0)
      expect(r.json).toEqual({ ok: true, verb: 'chat', complete: true, cooldown: null, chat: null })
      expectNoCanary(r.raw)
    }
    expect(sessionRows(env.paths.sessionFile).peers).not.toContain(DENIED)
    expect(Object.keys(JSON.parse(stateText(env)).known)).not.toContain(String(markChat(DENIED_GROUP)))
  })

  it('rejects a missing or malformed id before any lookup', async () => {
    const env = await loggedInEnv()
    for (const argv of [[], ['abc'], ['0'], ['1', '2'], ['@alice']]) {
      const r = await cli(env, 'chat', ...argv)
      expect(r.code).toBe(2)
      expect(r.json.error.code).toBe('bad_args')
    }
    expect(env.fake.methods()).not.toContain('messages.getPeerDialogs')
  })
})

describe('search', () => {
  it('searches every clean chat and nothing denied or hidden', async () => {
    const env = await loggedInEnv()
    const r = await cli(env, 'search', '--query', 'hello', '--json')
    expect(r.code).toBe(0)
    expect(r.json.messages.map((m: { text: string; chatTitle: string }) => [m.text, m.chatTitle])).toEqual([
      ['super hello', 'Northwind x Widget'],
      ['group hello', 'Northwind x Acme'],
      ['hello from Alice', 'Alice Clean'],
    ])
    expect(r.json.nextCursor).toBeNull()

    const body = await cli(env, 'search', '--query', 'body', '--json')
    expect(body.code).toBe(0)
    expect(body.json.messages).toEqual([])
    expectNoCanary(body.raw)

    const named = await cli(env, 'search', '--query', 'said hi', '--json')
    expect(named.json.messages.map((m: { text: string }) => m.text)).toEqual(['[hidden] said hi'])
    expectNoCanary(named.raw)
  })

  it('pages through results with the cursor', async () => {
    const env = await loggedInEnv()
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 5; i++) {
      const args = ['search', '--query', 'hello', '--limit', '1', ...(cursor ? ['--cursor', cursor] : [])]
      const r = await cli(env, ...args)
      expect(r.code).toBe(0)
      seen.push(...r.json.messages.map((m: { text: string }) => m.text))
      cursor = r.json.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(['super hello', 'group hello', 'hello from Alice'])
    expect((await cli(env, 'search', '--query', 'x', '--cursor', '{"rate":1}')).json.error.code).toBe('bad_args')
  })

  it('searches one known chat and refuses unknown ones', async () => {
    const env = await loggedInEnv()
    await cli(env, 'chats', '--json')
    const r = await cli(env, 'search', '--query', 'group', '--chat', String(markChat(CLEAN_GROUP)), '--json')
    expect(r.code).toBe(0)
    expect(r.json.chatId).toBe(String(markChat(CLEAN_GROUP)))
    expect(r.json.messages.map((m: { text: string }) => m.text)).toEqual(['group reply', 'group hello'])

    env.fake.calls.length = 0
    for (const id of [DENIED, markChat(DENIED_GROUP), markChannel(HIDDEN_SUPER), 99999]) {
      const bad = await cli(env, 'search', '--query', 'body', '--chat', String(id))
      expect(bad.json.error.code).toBe('chat_unavailable')
      expectNoCanary(bad.raw)
    }
    expect(env.fake.methods()).not.toContain('messages.search')
  })

  it('needs a query', async () => {
    const env = await loggedInEnv()
    expect((await cli(env, 'search')).json.error.code).toBe('bad_args')
    expect((await cli(env, 'search', '--query', '   ')).json.error.code).toBe('bad_args')
  })
})

describe('writes', () => {
  it('saves a draft in a known chat', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    const r = await cli(env, 'draft', String(ALICE), '--text', 'draft reply', '--reply-to', '17')
    expect(r.code).toBe(0)
    expect(env.fake.drafts).toEqual([{ peer: ALICE, text: 'draft reply' }])
  })

  it('marks read and archives, so the next sync skips the chat', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    let r = await cli(env, 'mark-read-archive', String(markChannel(CLEAN_SUPER)), '--max-id', '61')
    expect(r.code).toBe(0)
    expect(env.fake.readUpTo.get(markChannel(CLEAN_SUPER))).toBe(61)
    expect(env.fake.methods()).toEqual(expect.arrayContaining(['channels.readHistory', 'messages.readMentions', 'folders.editPeerFolders']))
    r = await cli(env, 'mark-read-archive', String(BOB), '--max-id', '20')
    expect(env.fake.methods()).toContain('messages.readHistory')
    env.clock.t += 60_000
    r = await cli(env, 'sync', '--json')
    const ids = r.json.items.map((i: { chatId: string }) => Number(i.chatId))
    expect(ids).not.toContain(markChannel(CLEAN_SUPER))
    expect(ids).not.toContain(BOB)
  })

  it('blocks every write in read-only mode', async () => {
    const env = await loggedInEnv({ config: { readOnly: true, allowSend: true } })
    await cli(env, 'sync', '--json')
    for (const argv of [
      ['draft', String(ALICE), '--text', 'x'],
      ['mark-read-archive', String(ALICE), '--max-id', '17'],
      ['send', String(ALICE), '--text', 'x'],
    ]) {
      const r = await cli(env, ...argv)
      expect(r.json.error.code).toBe('read_only')
    }
    expect(env.fake.drafts).toEqual([])
    expect(env.fake.sent).toEqual([])
    expect(env.fake.methods()).not.toContain('messages.readHistory')
  })

  it('refuses to send unless enabled', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    const r = await cli(env, 'send', String(ALICE), '--text', 'hi')
    expect(r.json.error.code).toBe('send_disabled')
    expect(env.fake.sent).toEqual([])
  })

  it('caps sends per day and persists the count', async () => {
    const env = await loggedInEnv({ config: { allowSend: true, dailySendCap: 2 } })
    await cli(env, 'sync', '--json')
    for (let i = 0; i < 2; i++) {
      env.clock.t += 20_000
      const r = await cli(env, 'send', String(ALICE), '--text', `hi ${i}`)
      expect(r.code).toBe(0)
      expect(r.json.sendsToday).toBe(i + 1)
    }
    env.clock.t += 20_000
    const r = await cli(env, 'send', String(ALICE), '--text', 'three')
    expect(r.json.error.code).toBe('send_cap')
    expect(env.fake.sent.length).toBe(2)
    env.clock.t += 25 * 60 * 60 * 1000
    expect((await cli(env, 'send', String(ALICE), '--text', 'next day')).code).toBe(0)
  })

  it('rejects a send cap above 20', async () => {
    const env = makeEnv({ config: { allowSend: true, dailySendCap: 50 } })
    const r = await cli(env, 'status')
    expect(r.json.error.code).toBe('config_invalid')
  })

  it('refuses writes to denied chats without touching Telegram', async () => {
    const env = await loggedInEnv({ config: { allowSend: true } })
    await cli(env, 'sync', '--json')
    env.fake.calls.length = 0
    for (const argv of [
      ['draft', String(DENIED), '--text', 'x'],
      ['mark-read-archive', String(markChannel(DENIED_SUPER)), '--max-id', '1'],
      ['send', String(markChat(DENIED_GROUP)), '--text', 'x'],
    ]) {
      const r = await cli(env, ...argv)
      expect(r.json.error.code).toBe('chat_unavailable')
    }
    expect(env.fake.calls).toEqual([])
  })
})

describe('flood', () => {
  it('persists a long FLOOD_WAIT and refuses early retries across runs', async () => {
    const env = await loggedInEnv()
    env.fake.inject.set('messages.getDialogs', ['FLOOD_WAIT_600'])
    let r = await cli(env, 'sync', '--json')
    expect(r.code).toBe(3)
    expect(r.json.error.code).toBe('cooldown')
    const until = Date.parse(r.json.error.until)
    expect(until).toBeGreaterThan(env.clock.t)
    env.fake.calls.length = 0
    env.clock.t += 60_000
    r = await cli(env, 'sync', '--json')
    expect(r.json.error.code).toBe('cooldown')
    expect(env.fake.methods()).not.toContain('messages.getDialogs')
    const status = await cli(env, 'status')
    expect(status.json.cooldown).toBe(new Date(until).toISOString())
    env.clock.t = until + 1
    r = await cli(env, 'sync', '--json')
    expect(r.code).toBe(0)
  })

  it('retries once after a short FLOOD_WAIT', async () => {
    const env = await loggedInEnv()
    env.fake.inject.set('messages.getDialogs', ['FLOOD_WAIT_3'])
    const r = await cli(env, 'sync', '--json')
    expect(r.code).toBe(0)
    expect(env.fake.methods().filter((m) => m === 'messages.getDialogs').length).toBe(2)
  })

  it('trips the 24 h breaker on a very long wait', async () => {
    const env = await loggedInEnv()
    env.fake.inject.set('messages.getDialogs', ['FLOOD_WAIT_7200'])
    await cli(env, 'sync', '--json')
    env.clock.t += 3 * 60 * 60 * 1000
    const r = await cli(env, 'whoami')
    expect(r.json.error.code).toBe('cooldown')
  })
})

describe('status and login state', () => {
  it('reports not logged in without touching the network', async () => {
    const env = makeEnv()
    const s = await cli(env, 'status')
    expect(s.code).toBe(0)
    expect(s.json).toMatchObject({ ok: true, installed: true, loggedIn: false, allowSend: false, readOnly: false })
    const r = await cli(env, 'sync', '--json')
    expect(r.code).toBe(5)
    expect(r.json.error.code).toBe('not_logged_in')
    expect(env.fake.calls).toEqual([])
  })

  it('reports logged in after login, without touching the network', async () => {
    const env = await loggedInEnv()
    const s = await cli(env, 'status')
    expect(s.json).toMatchObject({ ok: true, loggedIn: true })
    expect(env.fake.calls).toEqual([])
  })

  it('whoami returns only the account owner', async () => {
    const env = await loggedInEnv()
    const r = await cli(env, 'whoami')
    expect(r.json).toMatchObject({ ok: true, name: 'Self', username: 'selfuser' })
  })

  it('fails closed on a missing or unsafe config', async () => {
    const env = makeEnv()
    const { chmodSync } = await import('node:fs')
    chmodSync(env.paths.denylistFile, 0o644)
    expect((await cli(env, 'status')).json.error.code).toBe('config_invalid')
    chmodSync(env.paths.denylistFile, 0o640)
    chmodSync(env.paths.stateDir, 0o750)
    expect((await cli(env, 'status')).json.error.code).toBe('config_invalid')
  })

  it('refuses an empty denylist for user verbs', async () => {
    const env = makeEnv({ denylist: () => ({ version: 1, users: [], chats: [], allowChats: [] }) })
    expect((await cli(env, 'status')).json.error.code).toBe('config_invalid')
  })

  it('rejects unknown verbs and flags', async () => {
    const env = await loggedInEnv()
    for (const argv of [['call', 'messages.getHistory'], ['sync', '--raw'], ['read'], ['read', 'abc']]) {
      const r = await cli(env, ...argv)
      expect(r.code).toBe(2)
      expect(r.json.error.code).toBe('bad_args')
    }
  })
})

describe('admin', () => {
  it('login stores the session only in the state directory', async () => {
    const env = makeEnv({ denylist: () => ({ version: 1, users: [], chats: [], allowChats: [] }) })
    const r = await admin(env, ['+15550000000', '12345'], 'login')
    expect(r.code).toBe(0)
    expect(existsSync(env.paths.sessionFile)).toBe(true)
    expect(env.fake.methods()).toEqual(['auth.sendCode', 'auth.signIn'])
  })

  it('points an existing local session at the supported re-login commands', async () => {
    const env = await loggedInEnv()
    env.fake.calls.length = 0
    const r = await admin(env, [], 'login')
    expect(r.code).toBe(0)
    expect(r.said).toEqual(['A local session already exists. Run `sudo tg-admin logout`, then `sudo tg-admin login` again.'])
    expect(env.fake.calls).toEqual([])
  })

  it('deny-lookup captures the access hash and names without caching the user', async () => {
    const env = makeEnv({ denylist: () => ({ version: 1, users: [], chats: [], allowChats: [] }) })
    await admin(env, ['+15550000000', '12345'], 'login')
    const r = await admin(env, [], 'deny-lookup', String(DENIED), '--note', 'ex')
    expect(r.code).toBe(0)
    const list = JSON.parse(r.out)
    const user = list.users.find((u: { id: number }) => u.id === DENIED)
    expect(user.accessHash).toBe(env.fake.users.get(DENIED)!.hash.toString())
    expect(user.redact).toEqual(expect.arrayContaining(['CANARY Mallory', '@canarymal']))
    expect(user.note).toBe('ex')
    // Status lines are fixed text only.
    for (const line of r.said) expectNoCanary(line)
    const bytes = sessionBytes(env).toString('latin1')
    expect(bytes).not.toMatch(/canary/i)
    expect(sessionRows(env.paths.sessionFile).peers).not.toContain(DENIED)
  })

  it('deny-chat and deny-remove print a new list without network', async () => {
    const env = makeEnv()
    let r = await admin(env, [], 'deny-chat', String(markChat(12345)))
    expect(JSON.parse(r.out).chats).toEqual([markChat(12345)])
    r = await admin(env, [], 'deny-remove', String(DENIED))
    expect(JSON.parse(r.out).users).toEqual([])
    expect(env.fake.calls).toEqual([])
    await expect(admin(env, [], 'deny-remove', String(SERVICE))).rejects.toThrow()
  })

  it('removing a user from the denylist resets the membership cache', async () => {
    const env = await loggedInEnv()
    await cli(env, 'sync', '--json')
    const list = baseDenylist(env.fake)
    list.users.push({ id: BOB, accessHash: env.fake.users.get(BOB)!.hash.toString(), redact: [] })
    writeJson(env.paths.denylistFile, list)
    env.clock.t += 60_000
    // Adding Bob: his DM and the groups he is in must disappear at once.
    const r = await cli(env, 'sync', '--json')
    const ids = r.json.items.map((i: { chatId: string }) => Number(i.chatId))
    expect(ids).not.toContain(BOB)
    expect(ids).not.toContain(markChat(CLEAN_GROUP))
    expect(ids).not.toContain(markChannel(CLEAN_SUPER))
    expect(ids).toContain(ALICE)
    expect(sessionRows(env.paths.sessionFile).peers).not.toContain(BOB)
  })
})
