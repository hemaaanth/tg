import type { RpcCallMiddleware } from '@mtcute/core'
import { Long } from '@mtcute/core'

// A fake Telegram. It sits at the end of the middleware chain and answers
// every allowed method from a small world model. No socket is ever opened.
//
// Everything that belongs to a denied peer carries the word CANARY, so a
// test can grep any output, file or log for it.

export const SELF = 1110111
export const ALICE = 2220222
export const BOB = 2230223
export const DENIED = 6660666
export const DENIED_NO_HASH = 6670667
export const SERVICE = 777000
export const WORK_USER = 8880888

export const CLEAN_GROUP = 3330333 // basic group, clean
export const DENIED_GROUP = 4440444 // basic group, DENIED is a member
export const SERVICE_GROUP = 4450445 // basic group, a service message adds DENIED
export const CLEAN_SUPER = 5550555 // supergroup, clean
export const DENIED_SUPER = 5560556 // supergroup, DENIED is a member
export const HIDDEN_SUPER = 5570557 // supergroup, member list hidden
export const REACT_SUPER = 5580558 // supergroup, DENIED reacted but is not a member
export const BROADCAST = 5590559 // broadcast channel

export const markChannel = (id: number) => -1000000000000 - id
export const markChat = (id: number) => -id

export interface FakeUser {
  id: number
  hash: Long
  firstName: string
  lastName?: string
  username?: string
  bot?: boolean
}

export interface FakeChat {
  id: number
  kind: 'chat' | 'channel'
  hash?: Long
  title: string
  username?: string
  megagroup?: boolean
  broadcast?: boolean
  members: number[]
  hiddenMembers?: boolean
}

export interface FakeMessage {
  id: number
  from: number
  text: string
  date: number
  out?: boolean
  fwdFromUser?: number
  fwdFromName?: string
  mention?: { userId: number; offset: number; length: number }
  service?: { _: string; users?: number[]; userId?: number }
  reactionBy?: number
  replyToPeer?: number
}

export interface FakeDialog {
  peer: number // marked
  folder: 0 | 1
  unread: number
  readInboxMaxId: number
  mentions?: number
}

export interface Call {
  method: string
  request: Record<string, unknown>
}

function peerOf(marked: number): Record<string, unknown> {
  if (marked > 0) return { _: 'peerUser', userId: marked }
  if (marked <= -1000000000000) return { _: 'peerChannel', channelId: -1000000000000 - marked }
  return { _: 'peerChat', chatId: -marked }
}

function markedOfInput(p: Record<string, unknown> | undefined): number | null {
  if (!p) return null
  switch (p._) {
    case 'inputPeerUser':
    case 'inputUser':
      return p.userId as number
    case 'inputPeerChat':
      return -(p.chatId as number)
    case 'inputPeerChannel':
    case 'inputChannel':
      return markChannel(p.channelId as number)
    case 'inputPeerSelf':
    case 'inputUserSelf':
      return SELF
    default:
      return null
  }
}

function rpcError(message: string, code = 400) {
  return { _: 'mt_rpc_error', errorCode: code, errorMessage: message }
}

export class FakeTelegram {
  users = new Map<number, FakeUser>()
  chats = new Map<number, FakeChat>() // keyed by marked id
  history = new Map<number, FakeMessage[]>() // keyed by marked id
  dialogs: FakeDialog[] = []
  drafts: Array<{ peer: number; text: string }> = []
  sent: Array<{ peer: number; text: string }> = []
  invited: Array<{ peer: number; user: number; fwdLimit: number | null }> = []
  readUpTo = new Map<number, number>()
  calls: Call[] = []
  /** One-shot errors: method → error text, consumed on use. */
  inject = new Map<string, string[]>()
  loggedIn = true
  dialogPageCap: number | null = null
  dialogCountOverstatement = 0
  repeatDialogsPage = false
  omitTopFor = new Set<number>()

  constructor() {
    const u = (id: number, firstName: string, extra: Partial<FakeUser> = {}) =>
      this.users.set(id, { id, hash: Long.fromNumber(id * 7 + 3), firstName, ...extra })
    u(SELF, 'Self', { username: 'selfuser' })
    u(ALICE, 'Alice', { lastName: 'Clean', username: 'alice' })
    u(BOB, 'Bob', { lastName: 'Clean' })
    u(DENIED, 'CANARY', { lastName: 'Mallory', username: 'canarymal' })
    u(DENIED_NO_HASH, 'CANARY', { lastName: 'Nohash' })
    u(SERVICE, 'Telegram CANARY-SERVICE')
    u(WORK_USER, 'Northwind', { lastName: 'Service', username: 'northwindservice' })

    const c = (chat: FakeChat) => this.chats.set(chat.kind === 'chat' ? -chat.id : markChannel(chat.id), chat)
    const h = (id: number) => Long.fromNumber(id * 11 + 5)
    c({ id: CLEAN_GROUP, kind: 'chat', title: 'Northwind x Acme', members: [SELF, ALICE, BOB, WORK_USER] })
    c({ id: DENIED_GROUP, kind: 'chat', title: 'CANARY basic group', members: [SELF, ALICE, DENIED] })
    c({ id: SERVICE_GROUP, kind: 'chat', title: 'CANARY service group', members: [SELF, ALICE] })
    c({ id: CLEAN_SUPER, kind: 'channel', hash: h(CLEAN_SUPER), title: 'Northwind x Widget', megagroup: true, members: [SELF, ALICE, BOB] })
    c({ id: DENIED_SUPER, kind: 'channel', hash: h(DENIED_SUPER), title: 'CANARY supergroup', megagroup: true, members: [SELF, BOB, DENIED] })
    c({ id: HIDDEN_SUPER, kind: 'channel', hash: h(HIDDEN_SUPER), title: 'Hidden supergroup', megagroup: true, members: [SELF, BOB], hiddenMembers: true })
    c({ id: REACT_SUPER, kind: 'channel', hash: h(REACT_SUPER), title: 'CANARY reaction supergroup', megagroup: true, members: [SELF, ALICE] })
    c({ id: BROADCAST, kind: 'channel', hash: h(BROADCAST), title: 'Broadcast channel', broadcast: true, members: [SELF] })

    const t = 1_750_000_000
    this.history.set(ALICE, [
      { id: 10, from: SELF, out: true, text: 'hi Alice', date: t },
      { id: 11, from: ALICE, text: 'hello from Alice', date: t + 1 },
      { id: 12, from: ALICE, text: 'CANARY forwarded body', date: t + 2, fwdFromUser: DENIED },
      { id: 13, from: ALICE, text: 'ask Mal about it', date: t + 3, mention: { userId: DENIED, offset: 4, length: 3 } },
      { id: 14, from: ALICE, text: 'CANARY Mallory said hi', date: t + 4 },
      { id: 15, from: ALICE, text: 'CANARY name-only forward', date: t + 5, fwdFromName: 'CANARY Mallory' },
      { id: 16, from: ALICE, text: `their id is ${DENIED}`, date: t + 6 },
      { id: 17, from: ALICE, text: 'last clean message', date: t + 7 },
    ])
    this.history.set(BOB, [{ id: 20, from: BOB, text: 'Bob says hi', date: t + 8 }])
    this.history.set(DENIED, [{ id: 30, from: DENIED, text: 'CANARY direct message', date: t + 9 }])
    this.history.set(SERVICE, [{ id: 31, from: SERVICE, text: 'CANARY login code 12345', date: t + 10 }])
    this.history.set(markChat(CLEAN_GROUP), [
      { id: 40, from: ALICE, text: 'group hello', date: t + 11 },
      { id: 41, from: BOB, text: 'group reply', date: t + 12 },
    ])
    this.history.set(markChat(DENIED_GROUP), [{ id: 50, from: ALICE, text: 'CANARY group body', date: t + 13 }])
    this.history.set(markChat(SERVICE_GROUP), [
      { id: 55, from: ALICE, text: '', date: t + 14, service: { _: 'messageActionChatAddUser', users: [DENIED] } },
      { id: 56, from: ALICE, text: 'CANARY after add', date: t + 15 },
    ])
    this.history.set(markChannel(CLEAN_SUPER), [
      { id: 60, from: BOB, text: 'super hello', date: t + 16 },
      { id: 61, from: ALICE, text: 'super reply', date: t + 17 },
    ])
    this.history.set(markChannel(DENIED_SUPER), [{ id: 70, from: BOB, text: 'CANARY super body', date: t + 18 }])
    this.history.set(markChannel(HIDDEN_SUPER), [{ id: 80, from: BOB, text: 'hidden super body', date: t + 19 }])
    this.history.set(markChannel(REACT_SUPER), [
      { id: 90, from: ALICE, text: 'CANARY reacted body', date: t + 20, reactionBy: DENIED },
      { id: 91, from: ALICE, text: 'CANARY second body', date: t + 21 },
    ])
    this.history.set(markChannel(BROADCAST), [{ id: 95, from: 0, text: 'broadcast post', date: t + 22 }])

    const d = (peer: number, unread: number, readInboxMaxId: number, folder: 0 | 1 = 0) =>
      this.dialogs.push({ peer, folder, unread, readInboxMaxId })
    // Newest first, as Telegram lists them.
    d(markChannel(BROADCAST), 1, 94)
    d(markChannel(REACT_SUPER), 2, 89)
    d(markChannel(HIDDEN_SUPER), 1, 79)
    d(markChannel(DENIED_SUPER), 1, 69)
    d(markChannel(CLEAN_SUPER), 2, 59)
    d(markChat(SERVICE_GROUP), 2, 54)
    d(markChat(DENIED_GROUP), 1, 49)
    d(markChat(CLEAN_GROUP), 2, 39)
    d(SERVICE, 1, 30)
    d(DENIED, 1, 29)
    d(BOB, 1, 19)
    d(ALICE, 7, 10)
  }

  // ─── TL builders ────────────────────────────────────────────────────

  tlUser(id: number, min = false): Record<string, unknown> {
    const u = this.users.get(id)
    if (!u) return { _: 'userEmpty', id }
    return {
      _: 'user',
      id: u.id,
      self: id === SELF,
      bot: u.bot ?? false,
      min,
      accessHash: u.hash,
      firstName: u.firstName,
      lastName: u.lastName,
      username: u.username,
      phone: id === SELF ? '15550000000' : undefined,
    }
  }

  tlChat(marked: number): Record<string, unknown> {
    const c = this.chats.get(marked)!
    if (c.kind === 'chat') {
      return {
        _: 'chat',
        id: c.id,
        title: c.title,
        photo: { _: 'chatPhotoEmpty' },
        participantsCount: c.members.length,
        date: 1_700_000_000,
        version: 1,
        creator: true,
      }
    }
    return {
      _: 'channel',
      id: c.id,
      accessHash: c.hash,
      title: c.title,
      username: c.username,
      photo: { _: 'chatPhotoEmpty' },
      date: 1_700_000_000,
      megagroup: c.megagroup ?? false,
      broadcast: c.broadcast ?? false,
      creator: true,
    }
  }

  tlMessage(chat: number, m: FakeMessage): Record<string, unknown> {
    if (m.service) {
      return {
        _: 'messageService',
        id: m.id,
        peerId: peerOf(chat),
        fromId: peerOf(m.from),
        date: m.date,
        action: m.service,
      }
    }
    const msg: Record<string, unknown> = {
      _: 'message',
      id: m.id,
      out: m.out ?? false,
      peerId: peerOf(chat),
      date: m.date,
      message: m.text,
    }
    if (m.from && chat < 0) msg.fromId = peerOf(m.from)
    if (m.fwdFromUser) msg.fwdFrom = { _: 'messageFwdHeader', fromId: peerOf(m.fwdFromUser), date: m.date - 100 }
    if (m.fwdFromName) msg.fwdFrom = { _: 'messageFwdHeader', fromName: m.fwdFromName, date: m.date - 100 }
    if (m.mention) msg.entities = [{ _: 'messageEntityMentionName', ...m.mention }]
    if (m.reactionBy) {
      msg.reactions = {
        _: 'messageReactions',
        results: [],
        recentReactions: [{ _: 'messagePeerReaction', peerId: peerOf(m.reactionBy), date: m.date, reaction: { _: 'reactionEmoji', emoticon: '👍' } }],
      }
    }
    return msg
  }

  private usersFor(messages: FakeMessage[], extra: number[] = []): Record<string, unknown>[] {
    const ids = new Set<number>(extra)
    for (const m of messages) {
      if (m.from > 0) ids.add(m.from)
      if (m.fwdFromUser) ids.add(m.fwdFromUser)
      if (m.reactionBy) ids.add(m.reactionBy)
      if (m.mention) ids.add(m.mention.userId)
      for (const u of m.service?.users ?? []) ids.add(u)
    }
    return [...ids].filter((id) => this.users.has(id)).map((id) => this.tlUser(id))
  }

  // ─── handlers ───────────────────────────────────────────────────────

  private getDialogs(req: Record<string, unknown>) {
    const folder = (req.folderId as number | undefined) ?? 0
    const list = this.dialogs.filter((d) => d.folder === folder)
    const count = list.length + this.dialogCountOverstatement
    const offsetPeer = markedOfInput(req.offsetPeer as Record<string, unknown>)
    let start = 0
    if (!this.repeatDialogsPage && offsetPeer !== null) start = list.findIndex((d) => d.peer === offsetPeer) + 1
    const requested = req.limit as number
    const page = list.slice(start, start + Math.min(requested, this.dialogPageCap ?? requested))
    const messages: Record<string, unknown>[] = []
    const users = new Set<number>()
    const chats = new Set<number>()
    const dialogs = page.map((d) => {
      const hist = this.history.get(d.peer) ?? []
      const top = hist[hist.length - 1]
      if (top && !this.omitTopFor.has(d.peer)) messages.push(this.tlMessage(d.peer, top))
      if (top?.from) users.add(top.from)
      if (d.peer > 0) users.add(d.peer)
      else chats.add(d.peer)
      return {
        _: 'dialog',
        peer: peerOf(d.peer),
        topMessage: top?.id ?? 0,
        readInboxMaxId: d.readInboxMaxId,
        readOutboxMaxId: 0,
        unreadCount: d.unread,
        unreadMentionsCount: d.mentions ?? 0,
        unreadReactionsCount: 0,
        notifySettings: { _: 'peerNotifySettings' },
        folderId: folder,
      }
    })
    return {
      _: start + page.length < count ? 'messages.dialogsSlice' : 'messages.dialogs',
      count,
      dialogs,
      messages,
      chats: [...chats].map((c) => this.tlChat(c)),
      users: [...users].filter((u) => this.users.has(u)).map((u) => this.tlUser(u)),
    }
  }

  private getHistory(req: Record<string, unknown>) {
    const peer = markedOfInput(req.peer as Record<string, unknown>)
    if (peer === null || !this.history.has(peer)) return rpcError('PEER_ID_INVALID')
    let list = this.history.get(peer)!
    const minId = (req.minId as number) ?? 0
    const offsetId = (req.offsetId as number) ?? 0
    list = list.filter((m) => m.id > minId && (offsetId === 0 || m.id < offsetId))
    list = list.slice(-(req.limit as number)).reverse()
    const isChannel = peer <= -1000000000000
    return {
      _: isChannel ? 'messages.channelMessages' : 'messages.messages',
      ...(isChannel ? { pts: 1, count: list.length, topics: [] } : {}),
      messages: list.map((m) => this.tlMessage(peer, m)),
      chats: peer < 0 ? [this.tlChat(peer)] : [],
      users: this.usersFor(list, peer > 0 ? [peer] : []),
    }
  }

  private getPeerDialogs(req: Record<string, unknown>) {
    const peers = (req.peers as Array<{ peer: Record<string, unknown> }>).map((p) => markedOfInput(p.peer))
    const found = peers.map((m) => this.dialogs.find((d) => d.peer === m))
    if (found.some((d) => !d)) return rpcError('PEER_ID_INVALID')
    const page = found as FakeDialog[]
    const messages: Record<string, unknown>[] = []
    const users = new Set<number>()
    for (const d of page) {
      const top = this.history.get(d.peer)?.at(-1)
      if (top) messages.push(this.tlMessage(d.peer, top))
      if (top?.from) users.add(top.from)
      if (d.peer > 0) users.add(d.peer)
    }
    return {
      _: 'messages.peerDialogs',
      dialogs: page.map((d) => ({
        _: 'dialog',
        peer: peerOf(d.peer),
        topMessage: this.history.get(d.peer)?.at(-1)?.id ?? 0,
        readInboxMaxId: d.readInboxMaxId,
        readOutboxMaxId: 0,
        unreadCount: d.unread,
        unreadMentionsCount: d.mentions ?? 0,
        unreadReactionsCount: 0,
        notifySettings: { _: 'peerNotifySettings' },
        folderId: d.folder,
      })),
      messages,
      chats: page.filter((d) => d.peer < 0).map((d) => this.tlChat(d.peer)),
      users: [...users].filter((u) => this.users.has(u)).map((u) => this.tlUser(u)),
      state: { _: 'updates.state', pts: 1, qts: 0, date: 1, seq: 0, unreadCount: 0 },
    }
  }

  private getCommonChats(req: Record<string, unknown>) {
    const user = req.userId as { userId: number; accessHash: Long }
    const u = this.users.get(user.userId)
    if (!u || !u.hash.eq(user.accessHash)) return rpcError('USER_ID_INVALID')
    const maxId = req.maxId as number
    const shared = [...this.chats.entries()]
      .filter(([, c]) => c.members.includes(user.userId) && c.members.includes(SELF) && c.id > maxId)
      .sort((a, b) => a[1].id - b[1].id)
      .slice(0, req.limit as number)
    return { _: 'messages.chats', chats: shared.map(([m]) => this.tlChat(m)) }
  }

  private getFullChat(req: Record<string, unknown>) {
    const marked = -(req.chatId as number)
    const c = this.chats.get(marked)
    if (!c || c.kind !== 'chat') return rpcError('CHAT_ID_INVALID')
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull',
        id: c.id,
        about: '',
        participants: {
          _: 'chatParticipants',
          chatId: c.id,
          participants: c.members.map((u) => ({ _: 'chatParticipant', userId: u, inviterId: SELF, date: 1 })),
          version: 1,
        },
        notifySettings: { _: 'peerNotifySettings' },
      },
      chats: [this.tlChat(marked)],
      users: c.members.map((u) => this.tlUser(u)),
    }
  }

  private getParticipant(req: Record<string, unknown>) {
    const marked = markedOfInput(req.channel as Record<string, unknown>)
    const c = marked === null ? undefined : this.chats.get(marked)
    if (!c || !c.hash) return rpcError('CHANNEL_INVALID')
    if (c.hiddenMembers) return rpcError('CHAT_ADMIN_REQUIRED')
    const user = markedOfInput(req.participant as Record<string, unknown>)!
    if (!c.members.includes(user)) return rpcError('USER_NOT_PARTICIPANT')
    return {
      _: 'channels.channelParticipant',
      participant: { _: 'channelParticipant', userId: user, date: 1 },
      chats: [this.tlChat(marked!)],
      users: [this.tlUser(user)],
    }
  }

  private matches(m: FakeMessage, q: string): boolean {
    return !m.service && m.text.toLowerCase().includes(q.toLowerCase())
  }

  private search(req: Record<string, unknown>) {
    const peer = markedOfInput(req.peer as Record<string, unknown>)
    if (peer === null || !this.history.has(peer)) return rpcError('PEER_ID_INVALID')
    const offsetId = (req.offsetId as number) ?? 0
    const hits = this.history
      .get(peer)!
      .filter((m) => this.matches(m, req.q as string) && (offsetId === 0 || m.id < offsetId))
      .reverse()
    const page = hits.slice(0, req.limit as number)
    return {
      _: hits.length > page.length ? 'messages.messagesSlice' : 'messages.messages',
      ...(hits.length > page.length ? { count: hits.length } : {}),
      messages: page.map((m) => this.tlMessage(peer, m)),
      chats: peer < 0 ? [this.tlChat(peer)] : [],
      users: this.usersFor(page, peer > 0 ? [peer] : []),
    }
  }

  private searchGlobal(req: Record<string, unknown>) {
    const rate = (req.offsetRate as number) ?? 0
    const hits: Array<{ chat: number; m: FakeMessage }> = []
    for (const d of this.dialogs) {
      for (const m of this.history.get(d.peer) ?? []) {
        if (this.matches(m, req.q as string) && (rate === 0 || m.date < rate)) hits.push({ chat: d.peer, m })
      }
    }
    hits.sort((a, b) => b.m.date - a.m.date)
    const page = hits.slice(0, req.limit as number)
    const more = hits.length > page.length
    const peers = new Set(page.map((h) => h.chat))
    return {
      _: more ? 'messages.messagesSlice' : 'messages.messages',
      ...(more ? { count: hits.length, nextRate: page[page.length - 1].m.date } : {}),
      messages: page.map((h) => this.tlMessage(h.chat, h.m)),
      chats: [...peers].filter((p) => p < 0).map((p) => this.tlChat(p)),
      users: this.usersFor(page.map((h) => h.m), [...peers].filter((p) => p > 0)),
    }
  }

  handle(req: Record<string, unknown>): unknown {
    const method = req._ as string
    switch (method) {
      case 'help.getConfig':
        return rpcError('METHOD_NOT_FAKED')
      case 'messages.getDialogs':
        return this.getDialogs(req)
      case 'messages.getHistory':
        return this.getHistory(req)
      case 'messages.search':
        return this.search(req)
      case 'messages.searchGlobal':
        return this.searchGlobal(req)
      case 'messages.getPeerDialogs':
        return this.getPeerDialogs(req)
      case 'messages.getCommonChats':
        return this.getCommonChats(req)
      case 'messages.getFullChat':
        return this.getFullChat(req)
      case 'channels.getParticipant':
        return this.getParticipant(req)
      case 'contacts.getContacts':
        return {
          _: 'contacts.contacts',
          contacts: [ALICE, DENIED].map((id) => ({ _: 'contact', userId: id, mutual: true })),
          savedCount: 0,
          users: [this.tlUser(ALICE), this.tlUser(DENIED)],
        }
      case 'contacts.resolveUsername': {
        const name = (req.username as string).toLowerCase()
        const user = [...this.users.values()].find((u) => u.username?.toLowerCase() === name)
        if (user) return { _: 'contacts.resolvedPeer', peer: peerOf(user.id), chats: [], users: [this.tlUser(user.id)] }
        const chat = [...this.chats.entries()].find(([, c]) => c.username?.toLowerCase() === name)
        if (chat) return { _: 'contacts.resolvedPeer', peer: peerOf(chat[0]), chats: [this.tlChat(chat[0])], users: [] }
        return rpcError('USERNAME_NOT_OCCUPIED')
      }
      case 'users.getUsers':
        return [this.tlUser(SELF)]
      case 'messages.saveDraft':
        this.drafts.push({ peer: markedOfInput(req.peer as Record<string, unknown>)!, text: req.message as string })
        return true
      case 'messages.readHistory':
        this.readUpTo.set(markedOfInput(req.peer as Record<string, unknown>)!, req.maxId as number)
        return { _: 'messages.affectedMessages', pts: 1, ptsCount: 1 }
      case 'channels.readHistory':
        this.readUpTo.set(markedOfInput(req.channel as Record<string, unknown>)!, req.maxId as number)
        return true
      case 'messages.readMentions':
        return { _: 'messages.affectedHistory', pts: 1, ptsCount: 0, offset: 0 }
      case 'folders.editPeerFolders': {
        for (const fp of req.folderPeers as Array<{ peer: Record<string, unknown>; folderId: number }>) {
          const marked = markedOfInput(fp.peer)
          const d = this.dialogs.find((x) => x.peer === marked)
          if (d) d.folder = fp.folderId as 0 | 1
        }
        return { _: 'updates', updates: [], users: [], chats: [], date: 1, seq: 0 }
      }
      case 'messages.sendMessage': {
        const peer = markedOfInput(req.peer as Record<string, unknown>)!
        this.sent.push({ peer, text: req.message as string })
        return { _: 'updateShortSentMessage', id: 1000 + this.sent.length, pts: 1, ptsCount: 1, date: 1 }
      }
      case 'messages.addChatUser': {
        const peer = -(req.chatId as number)
        const user = markedOfInput(req.userId as Record<string, unknown>)!
        const chat = this.chats.get(peer)
        if (!chat) return rpcError('CHAT_ID_INVALID')
        if (!chat.members.includes(user)) chat.members.push(user)
        this.invited.push({ peer, user, fwdLimit: req.fwdLimit as number })
        return { _: 'updates', updates: [], users: [], chats: [], date: 1, seq: 0 }
      }
      case 'channels.inviteToChannel': {
        const peer = markedOfInput(req.channel as Record<string, unknown>)!
        const user = markedOfInput((req.users as Record<string, unknown>[])[0])!
        const chat = this.chats.get(peer)
        if (!chat) return rpcError('CHANNEL_INVALID')
        if (!chat.members.includes(user)) chat.members.push(user)
        this.invited.push({ peer, user, fwdLimit: null })
        return { _: 'updates', updates: [], users: [], chats: [], date: 1, seq: 0 }
      }
      case 'auth.sendCode':
        return { _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp', length: 5 }, phoneCodeHash: 'fakehash' }
      case 'auth.signIn':
        if (req.phoneCode !== '12345') return rpcError('PHONE_CODE_INVALID')
        return { _: 'auth.authorization', user: this.tlUser(SELF) }
      default:
        return rpcError('METHOD_NOT_FAKED')
    }
  }

  middleware(): RpcCallMiddleware {
    return async (ctx) => {
      const req = ctx.request as unknown as Record<string, unknown>
      const method = req._ as string
      this.calls.push({ method, request: req })
      const queued = this.inject.get(method)
      if (queued?.length) return rpcError(queued.shift()!, 420)
      return this.handle(req)
    }
  }

  methods(): string[] {
    return this.calls.map((c) => c.method)
  }
}
