import type { tl } from '@mtcute/core'
import { markedFromChatObject, markedFromPeer } from './ids.js'

// Turns scrubbed TL objects into the JSON contract.

export interface OutMessage {
  id: number
  date: string
  out: boolean
  senderId: string | null
  sender: string | null
  text: string
  hasMedia: boolean
  mediaType: string | null
  replyToId: number | null
}

export interface Names {
  users: Map<number, tl.RawUser>
  chats: Map<number, tl.RawChat | tl.RawChannel>
}

export function collectNames(res: { users?: tl.TypeUser[]; chats?: tl.TypeChat[] }, into?: Names): Names {
  const names: Names = into ?? { users: new Map(), chats: new Map() }
  for (const u of res.users ?? []) if (u._ === 'user') names.users.set(u.id, u)
  for (const c of res.chats ?? []) {
    const marked = markedFromChatObject(c)
    if (marked !== null && (c._ === 'chat' || c._ === 'channel')) names.chats.set(marked, c)
  }
  return names
}

export function userName(u: tl.RawUser | undefined): string | null {
  if (!u) return null
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
  return name || u.username || null
}

function mediaType(media: unknown): string | null {
  const t = (media as { _?: unknown } | undefined)?._
  if (typeof t !== 'string' || t === 'messageMediaEmpty') return null
  return t.replace(/^messageMedia/, '').toLowerCase() || null
}

/** Formats a plain message. Service messages and empty slots return null. */
export function formatMessage(m: tl.TypeMessage, chatMarked: number, selfId: number, names: Names): OutMessage | null {
  if (m._ !== 'message') return null
  let sender = markedFromPeer(m.fromId)
  if (sender === null) sender = m.out ? selfId : chatMarked
  const senderName = sender > 0 ? userName(names.users.get(sender)) : ((names.chats.get(sender)?.title as string) ?? null)
  const reply = m.replyTo && m.replyTo._ === 'messageReplyHeader' ? m.replyTo.replyToMsgId ?? null : null
  return {
    id: m.id,
    date: new Date(m.date * 1000).toISOString(),
    out: Boolean(m.out),
    senderId: String(sender),
    sender: senderName,
    text: m.message ?? '',
    hasMedia: mediaType(m.media) !== null,
    mediaType: mediaType(m.media),
    replyToId: reply,
  }
}

/** Messages from a history response for one chat, oldest first. */
export function messagesFor(
  res: { messages?: tl.TypeMessage[] },
  chatMarked: number,
  selfId: number,
  names: Names,
): OutMessage[] {
  const out: OutMessage[] = []
  for (const m of res.messages ?? []) {
    if (markedFromPeer((m as { peerId?: unknown }).peerId) !== chatMarked) continue
    const f = formatMessage(m, chatMarked, selfId, names)
    if (f) out.push(f)
  }
  return out.sort((a, b) => a.id - b.id)
}
