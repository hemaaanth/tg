import { SERVICE_USER_ID, markChannel, markChat, parseMarked } from './ids.js'

export interface DeniedUser {
  id: number
  /** Access hash as a decimal string. Needed for the common-chats probe. */
  accessHash: string | null
  note?: string
  /** Extra strings to hide in any text (names, usernames). */
  redact?: string[]
}

export interface Denylist {
  version: 1
  users: DeniedUser[]
  /** Marked chat ids that are always denied. */
  chats: number[]
  /**
   * Marked chat ids the admin vouches for when membership cannot be
   * checked (hidden member lists). Proof of a denied member still wins.
   */
  allowChats: number[]
}

/**
 * The set of peers that must never be read, cached or printed.
 * 777000 (Telegram service notifications) is always in it.
 */
export class DenySet {
  readonly users = new Set<number>([SERVICE_USER_ID])
  readonly chats = new Set<number>()
  readonly allowChats = new Set<number>()
  readonly terms: string[] = []
  /** Chats found during this run. The caller persists them. */
  readonly discovered = new Set<number>()

  constructor(list: Denylist, discoveredChats: Iterable<number> = []) {
    for (const u of list.users) this.users.add(u.id)
    for (const c of list.chats) this.chats.add(c)
    for (const c of list.allowChats) this.allowChats.add(c)
    for (const c of discoveredChats) this.chats.add(c)
    const terms = new Set<string>()
    for (const u of list.users) {
      for (const t of u.redact ?? []) {
        const norm = t.trim().toLowerCase()
        if (norm.length >= 3) terms.add(norm)
      }
    }
    // Longest first, so "Jane Doe" is replaced before "Jane".
    this.terms.push(...[...terms].sort((a, b) => b.length - a.length))
  }

  isUser(id: number): boolean {
    return this.users.has(id)
  }

  isChat(marked: number): boolean {
    return this.chats.has(marked)
  }

  /** Any marked id: user, chat or channel. */
  isMarked(marked: number): boolean {
    return marked > 0 ? this.users.has(marked) : this.chats.has(marked)
  }

  isRawChat(id: number): boolean {
    return this.chats.has(markChat(id))
  }

  isRawChannel(id: number): boolean {
    return this.chats.has(markChannel(id))
  }

  addChat(marked: number): void {
    if (marked > 0 || this.chats.has(marked)) return
    this.chats.add(marked)
    this.discovered.add(marked)
  }

  /** Every denied id as it could appear in text: marked and raw forms. */
  idStrings(): string[] {
    const out = new Set<string>()
    for (const u of this.users) out.add(String(u))
    for (const c of this.chats) {
      out.add(String(c))
      out.add(String(parseMarked(c)[1]))
    }
    return [...out]
  }

  /** True when a string mentions a redact term (case-insensitive). */
  matchesTerm(value: string | undefined | null): boolean {
    if (!value) return false
    const lower = value.toLowerCase()
    return this.terms.some((t) => lower.includes(t))
  }
}
