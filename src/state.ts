import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import type { DenySet, Denylist } from './deny-set.js'
import type { PeerKind } from './ids.js'

// Small JSON state file in the tg-only state directory. Holds flood
// deadlines, discovered denied chats, the membership cache and send counts.

export const DAY_MS = 24 * 60 * 60 * 1000
export const MEMBERSHIP_TTL_MS = DAY_MS
export const WORK_INVITE_WINDOW_MS = 23 * 60 * 60 * 1000

export type Membership = 'clean' | 'denied' | 'unknown'

export interface KnownChat {
  kind: PeerKind
  /** Highest inbound message id seen. 0 when none. */
  lastInboundId: number
  seenAt: number
}

export interface StateData {
  version: 1
  cooldowns: Record<string, number>
  breakerUntil: number | null
  lastCallAt: Record<string, number>
  deniedChats: number[]
  membership: Record<string, { status: Membership; at: number }>
  deniedUsersSnapshot: number[]
  commonChatsAt: Record<string, number>
  known: Record<string, KnownChat>
  sends: number[]
  workUser: { id: number; accessHash: string; username: string; name: string | null } | null
  workChats: Record<string, { title: string; seenAt: number; serviceUser?: 'present' | 'absent' | 'unknown' }>
  workInvites: number[]
  lastSyncAt: number | null
}

export function emptyState(): StateData {
  return {
    version: 1,
    cooldowns: {},
    breakerUntil: null,
    lastCallAt: {},
    deniedChats: [],
    membership: {},
    deniedUsersSnapshot: [],
    commonChatsAt: {},
    known: {},
    sends: [],
    workUser: null,
    workChats: {},
    workInvites: [],
    lastSyncAt: null,
  }
}

function parse(raw: string): StateData {
  const data = JSON.parse(raw) as Partial<StateData>
  if (!data || typeof data !== 'object' || data.version !== 1) return emptyState()
  return { ...emptyState(), ...data }
}

export class StateStore {
  data: StateData

  constructor(readonly file: string) {
    let raw: string | null = null
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.data = raw === null ? emptyState() : parse(raw)
  }

  /**
   * Brings the cache in line with the current denylist.
   * A removed user resets all discoveries, because we cannot tell which
   * chats were denied because of that user. An added user makes every
   * "clean" or "unknown" verdict stale.
   */
  reconcile(list: Denylist): void {
    const now = list.users.map((u) => u.id).sort((a, b) => a - b)
    const before = this.data.deniedUsersSnapshot
    const removed = before.some((id) => !now.includes(id))
    const added = now.some((id) => !before.includes(id))
    if (removed) {
      this.data.deniedChats = []
      this.data.membership = {}
      this.data.commonChatsAt = {}
    } else if (added) {
      for (const [chat, entry] of Object.entries(this.data.membership)) {
        if (entry.status !== 'denied') delete this.data.membership[chat]
      }
    }
    this.data.deniedUsersSnapshot = now
  }

  /** Drops known chats that are now denied and records discoveries. */
  absorb(deny: DenySet): void {
    const chats = new Set(this.data.deniedChats)
    for (const c of deny.discovered) {
      chats.add(c)
      this.data.membership[String(c)] = { status: 'denied', at: Date.now() }
    }
    this.data.deniedChats = [...chats]
    for (const key of Object.keys(this.data.known)) {
      if (deny.isMarked(Number(key))) delete this.data.known[key]
    }
    for (const key of Object.keys(this.data.workChats)) {
      if (deny.isMarked(Number(key))) delete this.data.workChats[key]
    }
  }

  membership(chat: number, now = Date.now()): Membership | null {
    const entry = this.data.membership[String(chat)]
    if (!entry) return null
    if (entry.status === 'denied') return 'denied'
    return now - entry.at < MEMBERSHIP_TTL_MS ? entry.status : null
  }

  setMembership(chat: number, status: Membership, now = Date.now()): void {
    this.data.membership[String(chat)] = { status, at: now }
  }

  sendsToday(now = Date.now()): number {
    this.data.sends = this.data.sends.filter((t) => now - t < DAY_MS)
    return this.data.sends.length
  }

  workInvitesToday(now = Date.now()): number {
    this.data.workInvites = this.data.workInvites.filter((t) => now - t < WORK_INVITE_WINDOW_MS)
    return this.data.workInvites.length
  }

  save(): void {
    const tmp = `${this.file}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(this.data))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
  }
}
