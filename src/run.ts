import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { RpcCallMiddleware } from '@mtcute/core'
import { tl } from '@mtcute/core'
import { runDraft, runMarkReadArchive, runRead, runSend, runWhoami } from './actions.js'
import { type ParsedArgs, intFlag, parseArgs, textFlag } from './args.js'
import { type ChatsFolder, parseSearchCursor, queryArg, runChat, runChats, runResolve, runSearch, usernameArg } from './browse.js'
import { openSession } from './client.js'
import { type Config, type Paths, type Trust, loadEnvironment } from './config.js'
import { DenySet, type Denylist } from './deny-set.js'
import { EXIT_CODES, ToolError, errorPayload, safeRpcName } from './errors.js'
import { type FloodDeps, activeCooldown } from './flood.js'
import type { Mode } from './guard.js'
import { parseChatIdArg } from './ids.js'
import { InstanceLock } from './lock.js'
import type { LogSink } from './logging.js'
import { assertClean, redactStrings } from './output.js'
import { DeniedContentError } from './scrub.js'
import { StateStore } from './state.js'
import { parseCursor, runSync } from './sync.js'
import type { Ctx } from './verify.js'
import { runInviteWorkUser, runWorkAudit } from './work.js'

// The user-facing entry. One verb per process, one JSON line on stdout.

export interface RunDeps {
  paths: Paths
  trust: Trust
  now?: () => number
  logSink?: LogSink
  logLevel?: number
  flood?: FloodDeps
  fakeTelegram?: RpcCallMiddleware
  lockWaitMs?: number
  write?: (line: string) => void
}

const VERBS: Record<string, { mode: Mode | null; flags: Record<string, 'value' | 'bool'> }> = {
  status: { mode: null, flags: {} },
  sync: { mode: 'sync', flags: { json: 'bool', since: 'value' } },
  chats: { mode: 'chats', flags: { json: 'bool', folder: 'value', query: 'value', limit: 'value' } },
  search: { mode: 'search', flags: { json: 'bool', query: 'value', chat: 'value', limit: 'value', cursor: 'value' } },
  read: { mode: 'read', flags: { json: 'bool', limit: 'value', before: 'value' } },
  draft: { mode: 'draft', flags: { json: 'bool', text: 'value', 'reply-to': 'value' } },
  'mark-read-archive': { mode: 'dismiss', flags: { json: 'bool', 'max-id': 'value' } },
  send: { mode: 'send', flags: { json: 'bool', text: 'value', 'reply-to': 'value' } },
  whoami: { mode: 'whoami', flags: { json: 'bool' } },
  'work-audit': { mode: 'work-audit', flags: { json: 'bool' } },
  'invite-work-user': { mode: 'invite-work-user', flags: { json: 'bool' } },
  resolve: { mode: 'resolve', flags: { json: 'bool' } },
  chat: { mode: 'chat', flags: { json: 'bool' } },
}

/** Lock wait per verb. A second sync gives up at once. */
function lockWait(verb: string, override?: number): number {
  if (override !== undefined) return override
  return verb === 'sync' ? 0 : 90_000
}

export interface Prepared {
  config: Config
  denylist: Denylist
  state: StateStore
  deny: DenySet
}

export function prepare(paths: Paths, trust: Trust): Prepared {
  const { config, denylist } = loadEnvironment(paths, trust)
  const state = new StateStore(paths.stateFile)
  state.reconcile(denylist)
  const deny = new DenySet(denylist, state.data.deniedChats)
  return { config, denylist, state, deny }
}

function sessionLoggedIn(file: string): boolean | null {
  if (!existsSync(file)) return false
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      // mtcute stores the logged-in user under this key (CurrentUserService).
      const row = db.prepare("select 1 from key_value where key = 'current_user'").get()
      return row !== undefined
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function chatArg(args: ParsedArgs): number {
  const id = parseChatIdArg(args.positional[0])
  if (id === null || args.positional.length !== 1) throw new ToolError('bad_args')
  return id
}

async function dispatch(args: ParsedArgs, ctx: Ctx): Promise<object> {
  const f = args.flags
  switch (args.verb) {
    case 'sync':
      if (args.positional.length) throw new ToolError('bad_args')
      return runSync(ctx, parseCursor(f.since as string | undefined))
    case 'chats': {
      if (args.positional.length) throw new ToolError('bad_args')
      const folder = (f.folder ?? 'main') as ChatsFolder
      if (!['main', 'archive', 'all'].includes(folder)) throw new ToolError('bad_args')
      return runChats(ctx, folder, queryArg(f.query, false), intFlag(f, 'limit', 1, 100) ?? 50)
    }
    case 'search': {
      if (args.positional.length) throw new ToolError('bad_args')
      let chat: number | undefined
      if (f.chat !== undefined) {
        const id = parseChatIdArg(f.chat as string)
        if (id === null) throw new ToolError('bad_args')
        chat = id
      }
      const query = queryArg(f.query, true) as string
      return runSearch(ctx, query, chat, intFlag(f, 'limit', 1, 50) ?? 20, parseSearchCursor(f.cursor as string | undefined))
    }
    case 'read':
      return runRead(ctx, chatArg(args), intFlag(f, 'limit', 1, 50), intFlag(f, 'before', 1, 2 ** 31 - 1))
    case 'draft':
      return runDraft(ctx, chatArg(args), textFlag(f, 'text'), intFlag(f, 'reply-to', 1, 2 ** 31 - 1))
    case 'mark-read-archive': {
      const maxId = intFlag(f, 'max-id', 1, 2 ** 31 - 1)
      if (maxId === undefined) throw new ToolError('bad_args')
      return runMarkReadArchive(ctx, chatArg(args), maxId)
    }
    case 'send':
      return runSend(ctx, chatArg(args), textFlag(f, 'text'), intFlag(f, 'reply-to', 1, 2 ** 31 - 1))
    case 'whoami':
      return runWhoami(ctx)
    case 'work-audit':
      if (args.positional.length) throw new ToolError('bad_args')
      return runWorkAudit(ctx)
    case 'invite-work-user':
      return runInviteWorkUser(ctx, chatArg(args))
    case 'resolve':
      if (args.positional.length !== 1) throw new ToolError('bad_args')
      return runResolve(ctx, usernameArg(args.positional[0]))
    case 'chat':
      return runChat(ctx, chatArg(args))
    default:
      throw new ToolError('bad_args')
  }
}

export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err
  if (err instanceof DeniedContentError) return new ToolError('denied_content')
  if (tl.RpcError.is(err)) return new ToolError('telegram_error', { rpc: safeRpcName(err.text) })
  return new ToolError('internal')
}

export function emit(write: (line: string) => void, value: object, deny: DenySet | null): void {
  let out = value
  if (deny) {
    out = redactStrings(value, deny)
    assertClean(out, deny)
  }
  write(JSON.stringify(out))
}

export function emitError(write: (line: string) => void, err: unknown): number {
  const e = toToolError(err)
  write(JSON.stringify({ ok: false, error: errorPayload(e) }))
  return EXIT_CODES[e.code]
}

export async function runCli(argv: string[], deps: RunDeps): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const now = deps.now ?? Date.now
  let lock: InstanceLock | null = null
  try {
    const verbName = argv[0] ?? ''
    const spec = Object.hasOwn(VERBS, verbName) ? VERBS[verbName] : undefined
    if (!spec) throw new ToolError('bad_args')
    const args = parseArgs(argv, spec.flags)
    const { config, denylist, state, deny } = prepare(deps.paths, deps.trust)

    if (spec.mode === null) {
      emit(
        write,
        {
          ok: true,
          verb: 'status',
          installed: true,
          loggedIn: sessionLoggedIn(deps.paths.sessionFile),
          readOnly: config.readOnly,
          allowSend: config.allowSend,
          dailySendCap: config.dailySendCap,
          sendsToday: state.sendsToday(now()),
          workUser: config.workUser,
          workTitle: config.workTitle,
          allowWorkInvite: config.allowWorkInvite,
          dailyWorkInviteCap: config.dailyWorkInviteCap,
          workInvitesToday: state.workInvitesToday(now()),
          lastSyncAt: state.data.lastSyncAt ? new Date(state.data.lastSyncAt).toISOString() : null,
          cooldown: activeCooldown(state, now()),
        },
        deny,
      )
      return 0
    }

    lock = InstanceLock.acquire(deps.paths.lockFile, lockWait(args.verb, deps.lockWaitMs))
    const session = await openSession({
      paths: deps.paths,
      config,
      deny,
      state,
      mode: spec.mode,
      logSink: deps.logSink,
      logLevel: deps.logLevel,
      flood: deps.flood,
      fakeTelegram: deps.fakeTelegram,
    })
    let result: object
    try {
      if (session.selfId === null) throw new ToolError('not_logged_in')
      const ctx: Ctx = { tg: session.tg, deny, state, config, denylist, selfId: session.selfId, now }
      result = await dispatch(args, ctx)
    } finally {
      await session.close()
    }
    emit(write, result, deny)
    return 0
  } catch (err) {
    return emitError(write, err)
  } finally {
    lock?.release()
  }
}
