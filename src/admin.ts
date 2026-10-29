import { Long, type tl } from '@mtcute/core'
import type { RpcCallMiddleware } from '@mtcute/core'
import { computeSrpParams } from '@mtcute/core/utils.js'
import { openSession } from './client.js'
import { type Paths, type Trust, loadEnvironment } from './config.js'
import { type DeniedUser, type Denylist, DenySet } from './deny-set.js'
import { ToolError } from './errors.js'
import { BUDGETS, type FloodDeps } from './flood.js'
import { SERVICE_USER_ID, markedFromPeer, parseChatIdArg } from './ids.js'
import { InstanceLock } from './lock.js'
import type { LogSink } from './logging.js'
import { StateStore } from './state.js'

// Admin verbs. These are NOT covered by the sudoers rule. Root runs them
// through the tg-admin wrapper, which drops to the tg user.
//
//   login                         interactive, needs a terminal
//   deny-lookup <id>... [--note]  prints a new denylist with access hashes
//   deny-remove <id>...           prints a new denylist without these users
//   deny-chat <markedId>...       prints a new denylist with these chats
//
// The deny-* verbs print the new denylist on stdout. The wrapper installs
// it as root. tg can read the denylist but never write it.

export interface Prompt {
  ask(question: string, secret?: boolean): Promise<string>
  say(line: string): void
}

export interface AdminDeps {
  paths: Paths
  trust: Trust
  prompt: Prompt
  write?: (text: string) => void
  logSink?: LogSink
  logLevel?: number
  flood?: FloodDeps
  fakeTelegram?: RpcCallMiddleware
}

const ADMIN_BUDGETS = { ...BUDGETS, 'messages.getDialogs': { max: 20, minIntervalMs: 2000 } }

function positiveIds(values: string[]): number[] {
  if (!values.length) throw new ToolError('bad_args')
  return values.map((v) => {
    const n = parseChatIdArg(v)
    if (n === null || n <= 0) throw new ToolError('bad_args')
    return n
  })
}

function printDenylist(list: Denylist, write: (text: string) => void): void {
  write(`${JSON.stringify(list, null, 2)}\n`)
}

async function login(deps: AdminDeps): Promise<void> {
  const { config, denylist } = loadEnvironment(deps.paths, deps.trust, true)
  const state = new StateStore(deps.paths.stateFile)
  const deny = new DenySet(denylist, state.data.deniedChats)
  const lock = InstanceLock.acquire(deps.paths.lockFile, 0)
  const session = await openSession({
    paths: deps.paths,
    config: { ...config, readOnly: true, allowSend: false },
    deny,
    state,
    mode: 'login',
    logSink: deps.logSink,
    logLevel: deps.logLevel,
    flood: deps.flood,
    fakeTelegram: deps.fakeTelegram,
  })
  try {
    if (session.selfId !== null) {
      deps.prompt.say('A local session already exists. Run `sudo tg-admin logout`, then `sudo tg-admin login` again.')
      return
    }
    const tg = session.tg
    const phoneNumber = (await deps.prompt.ask('Phone number (international format, e.g. +15551234567): ')).trim()
    if (!/^\+?\d{6,16}$/.test(phoneNumber)) throw new ToolError('bad_args')
    const sent = await tg.call({
      _: 'auth.sendCode',
      phoneNumber,
      apiId: config.apiId,
      apiHash: config.apiHash,
      settings: { _: 'codeSettings' },
    })
    let auth: tl.auth.TypeAuthorization
    if (sent._ === 'auth.sentCodeSuccess') {
      auth = sent.authorization
    } else if (sent._ === 'auth.sentCode') {
      const phoneCode = (await deps.prompt.ask('Login code: ')).trim()
      try {
        auth = await tg.call({ _: 'auth.signIn', phoneNumber, phoneCodeHash: sent.phoneCodeHash, phoneCode })
      } catch (err) {
        if (!(err instanceof Error) || !('text' in err) || err.text !== 'SESSION_PASSWORD_NEEDED') throw err
        const pwd = await tg.call({ _: 'account.getPassword' })
        const password = await deps.prompt.ask('2FA password: ', true)
        const srp = await computeSrpParams(tg.crypto, pwd, password)
        auth = await tg.call({ _: 'auth.checkPassword', password: srp })
      }
    } else {
      throw new ToolError('telegram_error')
    }
    const self = await tg.notifyLoggedIn(auth)
    deps.prompt.say(`Logged in as user ${self.id}.`)
  } finally {
    await session.close()
    lock.release()
  }
}

interface Captured {
  accessHash: string
  names: string[]
}

async function denyLookup(deps: AdminDeps, ids: number[], note: string, captureNames: boolean): Promise<Denylist> {
  const { config, denylist } = loadEnvironment(deps.paths, deps.trust, true)
  const state = new StateStore(deps.paths.stateFile)
  // The targets are denied from the first call, so none of their data
  // reaches the cache. The capture hook sees raw responses only to copy
  // the access hash and names into the denylist.
  const pending: Denylist = {
    ...denylist,
    users: [...denylist.users, ...ids.filter((id) => !denylist.users.some((u) => u.id === id)).map((id) => ({ id, accessHash: null }))],
  }
  const deny = new DenySet(pending, state.data.deniedChats)
  const captured = new Map<number, Captured>()
  const onRaw = (_method: string, res: unknown) => {
    const users = (res as { users?: tl.TypeUser[] }).users ?? []
    for (const u of users) {
      if (u._ !== 'user' || !ids.includes(u.id) || u.min || !u.accessHash) continue
      const names = [[u.firstName, u.lastName].filter(Boolean).join(' '), u.username ? `@${u.username}` : '', u.username ?? '']
      captured.set(u.id, { accessHash: u.accessHash.toString(), names: names.filter((n) => n.trim().length >= 3) })
    }
  }
  const lock = InstanceLock.acquire(deps.paths.lockFile, 90_000)
  const session = await openSession({
    paths: deps.paths,
    config: { ...config, readOnly: true, allowSend: false },
    deny,
    state,
    mode: 'deny-lookup',
    logSink: deps.logSink,
    logLevel: deps.logLevel,
    flood: { budgets: ADMIN_BUDGETS, ...deps.flood },
    fakeTelegram: deps.fakeTelegram,
    onRaw,
  })
  try {
    if (session.selfId === null) throw new ToolError('not_logged_in')
    const tg = session.tg
    await tg.call({ _: 'contacts.getContacts', hash: Long.ZERO })
    for (const folderId of [0, 1]) {
      let offsetDate = 0
      let offsetId = 0
      let offsetPeer: tl.TypeInputPeer = { _: 'inputPeerEmpty' }
      for (let page = 0; page < 10 && captured.size < ids.length; page++) {
        const res = (await tg.call({
          _: 'messages.getDialogs',
          folderId,
          offsetDate,
          offsetId,
          offsetPeer,
          limit: 100,
          hash: Long.ZERO,
        })) as tl.messages.RawDialogs | tl.messages.RawDialogsSlice
        if (res._ !== 'messages.dialogsSlice' || res.dialogs.length < 100) break
        const last = [...res.dialogs].reverse().find((d): d is tl.RawDialog => d._ === 'dialog')
        const marked = last ? markedFromPeer(last.peer) : null
        const peer = marked !== null ? await tg.storage.peers.getById(marked, false) : null
        const top = last ? res.messages.find((m) => m.id === last.topMessage && markedFromPeer((m as { peerId?: unknown }).peerId) === marked) : undefined
        if (!last || !peer || !top || top._ === 'messageEmpty') break
        offsetDate = top.date
        offsetId = last.topMessage
        offsetPeer = peer
      }
    }
  } finally {
    await session.close()
    lock.release()
  }

  const users: DeniedUser[] = pending.users.map((u) => {
    if (!ids.includes(u.id)) return u
    const c = captured.get(u.id)
    const redact = new Set(u.redact ?? [])
    if (c && captureNames) for (const n of c.names) redact.add(n)
    return {
      id: u.id,
      accessHash: c?.accessHash ?? u.accessHash ?? null,
      note: note || u.note || '',
      redact: [...redact],
    }
  })
  const missing = ids.filter((id) => !captured.has(id) && id !== SERVICE_USER_ID).length
  deps.prompt.say(`Looked up ${ids.length} user(s). ${missing} without an access hash.`)
  if (missing) {
    deps.prompt.say('Users without an access hash cannot be probed in supergroups.')
    deps.prompt.say('Supergroups are then hidden unless listed in allowChats.')
  }
  return { ...pending, users }
}

export async function runAdmin(argv: string[], deps: AdminDeps): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text))
  const [verb, ...rest] = argv
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--no-capture-names') flags.set('no-capture-names', true)
    else if (rest[i] === '--note' && rest[i + 1] !== undefined) flags.set('note', rest[++i])
    else if (rest[i].startsWith('--')) throw new ToolError('bad_args')
    else positional.push(rest[i])
  }
  switch (verb) {
    case 'login':
      await login(deps)
      return 0
    case 'deny-lookup': {
      const note = flags.get('note')
      const list = await denyLookup(deps, positiveIds(positional), typeof note === 'string' ? note : '', !flags.has('no-capture-names'))
      printDenylist(list, write)
      return 0
    }
    case 'deny-remove': {
      const ids = positiveIds(positional)
      if (ids.includes(SERVICE_USER_ID)) throw new ToolError('bad_args')
      const { denylist } = loadEnvironment(deps.paths, deps.trust, true)
      printDenylist({ ...denylist, users: denylist.users.filter((u) => !ids.includes(u.id)) }, write)
      return 0
    }
    case 'deny-chat': {
      const ids = positional.map((v) => parseChatIdArg(v))
      if (!ids.length || ids.some((n) => n === null || n >= 0)) throw new ToolError('bad_args')
      const { denylist } = loadEnvironment(deps.paths, deps.trust, true)
      const chats = new Set([...denylist.chats, ...(ids as number[])])
      printDenylist({ ...denylist, chats: [...chats] }, write)
      return 0
    }
    default:
      throw new ToolError('bad_args')
  }
}
