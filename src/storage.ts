import { existsSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { BaseSqliteStorage, BaseSqliteStorageDriver } from '@mtcute/core'
import type { ISqliteDatabase, ISqliteStatement } from '@mtcute/core'
import type { DenySet } from './deny-set.js'

// mtcute session storage on node:sqlite (no native module).
// Two extra rules on top of mtcute's own storage:
//   - the peer and message-ref repositories refuse denied ids, and
//   - purgeDenied() deletes any denied row left in the file.
// secure_delete overwrites deleted rows, and the rollback journal is
// deleted after each commit, so removed rows do not linger on disk.

type Bind = string | number | bigint | null | Uint8Array

function bindable(params: unknown[]): Bind[] {
  return params.map((p) => {
    if (p === undefined) return null
    if (typeof p === 'boolean') return p ? 1 : 0
    return p as Bind
  })
}

function plain(row: unknown): unknown {
  return row && typeof row === 'object' ? { ...(row as object) } : row
}

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = delete')
  db.exec('pragma secure_delete = on')
  return db
}

function adapt(db: DatabaseSync): ISqliteDatabase {
  let depth = 0
  return {
    transaction: (<F extends (...args: any[]) => any>(fn: F): F => {
      return ((...args: unknown[]) => {
        const sp = `sp${depth}`
        db.exec(depth === 0 ? 'begin' : `savepoint ${sp}`)
        depth++
        try {
          const res = fn(...args)
          depth--
          db.exec(depth === 0 ? 'commit' : `release ${sp}`)
          return res
        } catch (err) {
          depth--
          db.exec(depth === 0 ? 'rollback' : `rollback to ${sp}`)
          throw err
        }
      }) as F
    }) as ISqliteDatabase['transaction'],
    prepare: (<P extends unknown[]>(sql: string): ISqliteStatement<P> => {
      const stmt: StatementSync = db.prepare(sql)
      return {
        run: (...p: P) => {
          stmt.run(...bindable(p))
        },
        get: (...p: P) => plain(stmt.get(...bindable(p))),
        all: (...p: P) => stmt.all(...bindable(p)).map(plain),
      }
    }) as ISqliteDatabase['prepare'],
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  }
}

export class NodeSqliteDriver extends BaseSqliteStorageDriver {
  constructor(readonly filename: string) {
    super()
  }

  _createDatabase(): ISqliteDatabase {
    return adapt(openDatabase(this.filename))
  }
}

/** Counts refused writes. Tests read this. */
export interface StorageStats {
  refusedPeers: number
  refusedRefs: number
}

export class GuardedStorage extends BaseSqliteStorage {
  readonly stats: StorageStats = { refusedPeers: 0, refusedRefs: 0 }

  constructor(file: string, deny: DenySet) {
    super(new NodeSqliteDriver(file))
    const peerStore = this.peers.store.bind(this.peers)
    this.peers.store = (dto) => {
      if (deny.isMarked(dto.id)) {
        this.stats.refusedPeers++
        return
      }
      return peerStore(dto)
    }
    const refStore = this.refMessages.store.bind(this.refMessages)
    this.refMessages.store = (peerId, chatId, msgId) => {
      if (deny.isMarked(peerId) || deny.isMarked(chatId)) {
        this.stats.refusedRefs++
        return
      }
      return refStore(peerId, chatId, msgId)
    }
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== undefined
}

/**
 * Deletes every denied peer and message ref from a session file.
 * Runs before the client opens the file and after it closes it.
 */
export function purgeDenied(file: string, deny: DenySet): void {
  if (!existsSync(file)) return
  const db = openDatabase(file)
  try {
    const ids = [...deny.users, ...deny.chats]
    db.exec('begin')
    if (tableExists(db, 'peers')) {
      const del = db.prepare('delete from peers where id = ?')
      for (const id of ids) del.run(id)
    }
    if (tableExists(db, 'message_refs')) {
      const del = db.prepare('delete from message_refs where peer_id = ? or chat_id = ?')
      for (const id of ids) del.run(id, id)
    }
    db.exec('commit')
  } finally {
    db.close()
  }
}
