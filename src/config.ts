import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Denylist, DeniedUser } from './deny-set.js'
import { ToolError } from './errors.js'
import { SERVICE_USER_ID } from './ids.js'

// Paths, file checks and parsing. Every check fails closed: if a file is
// missing, unparsable, or writable by anyone but its trusted owner, the
// tool stops before it touches the network.

export interface Paths {
  configDir: string
  configFile: string
  denylistFile: string
  stateDir: string
  sessionFile: string
  stateFile: string
  lockFile: string
  wasmDir: string
}

export function pathsFor(configDir: string, stateDir: string, wasmDir: string): Paths {
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    denylistFile: join(configDir, 'denylist.json'),
    stateDir,
    sessionFile: join(stateDir, 'telegram.session'),
    stateFile: join(stateDir, 'state.json'),
    lockFile: join(stateDir, 'lock'),
    wasmDir,
  }
}

/** Production paths. The wasm files sit next to the root-owned bundle. */
export function productionPaths(): Paths {
  return pathsFor('/etc/tg', '/var/lib/tg', dirname(fileURLToPath(import.meta.url)))
}

export const MAX_DAILY_SEND_CAP = 20
export const MAX_DAILY_WORK_INVITE_CAP = 10
/** Telegram's public username rule. */
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/

export interface Config {
  apiId: number
  apiHash: string
  /** Blocks draft, mark-read, archive and send. */
  readOnly: boolean
  /** Real sends. Off unless set. */
  allowSend: boolean
  dailySendCap: number
  /** The work account that work-audit checks and invite-work-user adds. Null turns both off. */
  workUser: string | null
  /** A word that work-chat titles contain, matched whole and case-insensitively. Null turns both off. */
  workTitle: string | null
  /** One-at-a-time invitations of the work account. */
  allowWorkInvite: boolean
  dailyWorkInviteCap: number
}

export interface Trust {
  /** Owner of the config directory and files. 0 (root) in production. */
  configOwnerUid: number
  /** The uid this process runs as. Owns the state directory. */
  processUid: number
}

function fail(): never {
  throw new ToolError('config_invalid')
}

function checkOwned(path: string, kind: 'dir' | 'file', uid: number, forbiddenBits: number): void {
  let st
  try {
    st = lstatSync(path)
  } catch {
    fail()
  }
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) fail()
  if (st.uid !== uid) fail()
  if ((st.mode & forbiddenBits) !== 0) fail()
}

/** Checks ownership and modes of every file the tool trusts. */
export function checkPermissions(paths: Paths, trust: Trust): void {
  // Config: owned by root. Group (tg) may read, nobody else may.
  checkOwned(paths.configDir, 'dir', trust.configOwnerUid, 0o022)
  checkOwned(paths.configFile, 'file', trust.configOwnerUid, 0o027)
  checkOwned(paths.denylistFile, 'file', trust.configOwnerUid, 0o027)
  // State: owned by the service user, private.
  checkOwned(paths.stateDir, 'dir', trust.processUid, 0o077)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail()
  }
}

export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') fail()
  const c = raw as Record<string, unknown>
  if (typeof c.apiId !== 'number' || !Number.isSafeInteger(c.apiId) || c.apiId <= 0) fail()
  if (typeof c.apiHash !== 'string' || !/^[0-9a-f]{32}$/i.test(c.apiHash)) fail()
  const readOnly = c.readOnly ?? false
  const allowSend = c.allowSend ?? false
  const cap = c.dailySendCap ?? MAX_DAILY_SEND_CAP
  const allowWorkInvite = c.allowWorkInvite ?? false
  const workCap = c.dailyWorkInviteCap ?? 0
  const workUser = c.workUser ?? null
  const workTitle = c.workTitle ?? null
  if (workUser !== null && (typeof workUser !== 'string' || !USERNAME.test(workUser))) fail()
  if (workTitle !== null && (typeof workTitle !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(workTitle))) fail()
  if (typeof readOnly !== 'boolean' || typeof allowSend !== 'boolean' || typeof allowWorkInvite !== 'boolean') fail()
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0 || cap > MAX_DAILY_SEND_CAP) fail()
  if (typeof workCap !== 'number' || !Number.isSafeInteger(workCap) || workCap < 0 || workCap > MAX_DAILY_WORK_INVITE_CAP) fail()
  return {
    apiId: c.apiId,
    apiHash: c.apiHash,
    readOnly,
    allowSend,
    dailySendCap: cap,
    workUser: workUser === null ? null : workUser.toLowerCase(),
    workTitle,
    allowWorkInvite,
    dailyWorkInviteCap: workCap,
  }
}

function isIdList(v: unknown, sign: 1 | -1): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && Math.sign(n) === sign)
}

export function parseDenylist(raw: unknown, allowEmpty = false): Denylist {
  if (!raw || typeof raw !== 'object') fail()
  const d = raw as Record<string, unknown>
  if (d.version !== 1 || !Array.isArray(d.users)) fail()
  const users: DeniedUser[] = d.users.map((u) => {
    if (!u || typeof u !== 'object') fail()
    const x = u as Record<string, unknown>
    if (typeof x.id !== 'number' || !Number.isSafeInteger(x.id) || x.id <= 0) fail()
    const hash = x.accessHash ?? null
    if (hash !== null && (typeof hash !== 'string' || !/^-?\d{1,20}$/.test(hash))) fail()
    const note = x.note ?? ''
    const redact = x.redact ?? []
    if (typeof note !== 'string') fail()
    if (!Array.isArray(redact) || !redact.every((r) => typeof r === 'string')) fail()
    return { id: x.id, accessHash: hash, note, redact }
  })
  // An empty denylist is treated as a broken one.
  if (!allowEmpty && !users.some((u) => u.id !== SERVICE_USER_ID)) fail()
  const chats = d.chats ?? []
  const allowChats = d.allowChats ?? []
  if (!isIdList(chats, -1) || !isIdList(allowChats, -1)) fail()
  return { version: 1, users, chats, allowChats }
}

export interface Environment {
  config: Config
  denylist: Denylist
}

/**
 * Loads config and denylist. Only the admin login and lookup verbs may
 * run with an empty denylist; they read no chats.
 */
export function loadEnvironment(paths: Paths, trust: Trust, allowEmptyDenylist = false): Environment {
  if (trust.processUid === 0 && trust.configOwnerUid === 0) fail()
  checkPermissions(paths, trust)
  return {
    config: parseConfig(readJson(paths.configFile)),
    denylist: parseDenylist(readJson(paths.denylistFile), allowEmptyDenylist),
  }
}
