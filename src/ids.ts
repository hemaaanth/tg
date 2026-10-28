// Peer id helpers. Telegram uses three id spaces. We use "marked" ids
// everywhere so one number names one peer:
//   user     →  id
//   chat     → -id
//   channel  → -1000000000000 - id

export const SERVICE_USER_ID = 777000
const CHANNEL_BASE = -1000000000000

export type PeerKind = 'user' | 'chat' | 'channel'

export function markUser(id: number): number {
  return id
}

export function markChat(id: number): number {
  return -id
}

export function markChannel(id: number): number {
  return CHANNEL_BASE - id
}

export function parseMarked(marked: number): [PeerKind, number] {
  if (marked > 0) return ['user', marked]
  if (marked <= CHANNEL_BASE) return ['channel', CHANNEL_BASE - marked]
  return ['chat', -marked]
}

/** Parses a chat id given on the command line. Returns null when invalid. */
export function parseChatIdArg(value: string | undefined): number | null {
  if (!value || !/^-?\d{1,16}$/.test(value)) return null
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n === 0) return null
  return n
}

/**
 * Marked id for TL peer-like objects: peerUser, peerChat, peerChannel,
 * inputPeer*, inputUser, inputChannel. Returns null for self/empty peers.
 */
export function markedFromPeer(peer: unknown): number | null {
  if (!peer || typeof peer !== 'object') return null
  const p = peer as Record<string, unknown>
  switch (p._) {
    case 'peerUser':
    case 'inputPeerUser':
    case 'inputUser':
    case 'inputPeerUserFromMessage':
    case 'inputUserFromMessage':
      return typeof p.userId === 'number' ? markUser(p.userId) : null
    case 'peerChat':
    case 'inputPeerChat':
      return typeof p.chatId === 'number' ? markChat(p.chatId) : null
    case 'peerChannel':
    case 'inputPeerChannel':
    case 'inputChannel':
    case 'inputPeerChannelFromMessage':
    case 'inputChannelFromMessage':
      return typeof p.channelId === 'number' ? markChannel(p.channelId) : null
    default:
      return null
  }
}

/** Marked id for chat objects (chat, chatForbidden, channel, …). */
export function markedFromChatObject(chat: unknown): number | null {
  if (!chat || typeof chat !== 'object') return null
  const c = chat as Record<string, unknown>
  if (typeof c.id !== 'number') return null
  switch (c._) {
    case 'chat':
    case 'chatForbidden':
    case 'chatEmpty':
      return markChat(c.id)
    case 'channel':
    case 'channelForbidden':
    case 'community':
    case 'communityForbidden':
      return markChannel(c.id)
    default:
      return null
  }
}
