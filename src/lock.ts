import { DatabaseSync } from 'node:sqlite'
import { ToolError } from './errors.js'

// Single-instance lock. An exclusive SQLite transaction on a lock file.
// The kernel drops the lock when the process exits, so a crash never
// leaves a stale lock behind.

export class InstanceLock {
  private db: DatabaseSync | null

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  static acquire(file: string, waitMs: number): InstanceLock {
    const db = new DatabaseSync(file)
    try {
      db.exec(`pragma busy_timeout = ${Math.max(0, Math.floor(waitMs))}`)
      db.exec('begin exclusive')
    } catch {
      db.close()
      throw new ToolError('locked')
    }
    return new InstanceLock(db)
  }

  release(): void {
    if (!this.db) return
    try {
      this.db.exec('rollback')
    } catch {
      // Closing the handle releases the lock anyway.
    }
    this.db.close()
    this.db = null
  }
}
