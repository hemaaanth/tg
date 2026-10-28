import { connectTcp } from '@fuman/node'
import { IntermediatePacketCodec, networkMiddlewares } from '@mtcute/core'
import { BaseTelegramClient } from '@mtcute/core/client.js'
import type { RpcCallMiddleware, TelegramTransport } from '@mtcute/core'
import type { Config, Paths } from './config.js'
import { PinnedCryptoProvider } from './crypto.js'
import type { DenySet } from './deny-set.js'
import { type FloodDeps, floodGuard } from './flood.js'
import { denyGuard, type Mode } from './guard.js'
import { createLogger, type LogSink, SafePlatform } from './logging.js'
import type { StateStore } from './state.js'
import { GuardedStorage, purgeDenied } from './storage.js'

// Builds the mtcute client with our middleware chain:
//   denyGuard → floodGuard → internal-error retry → network
// Updates are off. There is no update loop and no raw-API entry point.

class TcpTransport implements TelegramTransport {
  async connect(dc: { ipAddress: string; port: number }, abortSignal: AbortSignal) {
    const conn = await connectTcp({ address: dc.ipAddress, port: dc.port }, abortSignal)
    conn.setNoDelay(true)
    conn.setKeepAlive(true)
    return conn
  }

  packetCodec() {
    return new IntermediatePacketCodec()
  }
}

export interface SessionOptions {
  paths: Paths
  config: Config
  deny: DenySet
  state: StateStore
  mode: Mode
  logSink?: LogSink
  logLevel?: number
  flood?: FloodDeps
  /** Admin only: raw response hook, runs before the scrub. */
  onRaw?: (method: string, res: unknown) => void
  /** Tests only: answers RPCs instead of the network. */
  fakeTelegram?: RpcCallMiddleware
}

export interface Session {
  tg: BaseTelegramClient
  storage: GuardedStorage
  selfId: number | null
  close(): Promise<void>
}

export async function openSession(opts: SessionOptions): Promise<Session> {
  const { paths, config, deny, state } = opts
  purgeDenied(paths.sessionFile, deny)

  const platform = new SafePlatform(opts.logSink, opts.logLevel)
  const middlewares: RpcCallMiddleware[] = [
    denyGuard({
      deny,
      mode: opts.mode,
      readOnly: config.readOnly,
      allowSend: config.allowSend,
      allowWorkInvite: config.allowWorkInvite,
      onRaw: opts.onRaw,
    }),
    floodGuard(state, opts.flood),
  ]
  // An invitation is not idempotent. Never retry it after an ambiguous server error.
  if (opts.mode !== 'invite-work-user') middlewares.push(networkMiddlewares.internalErrorsHandler({ maxRetries: 2 }))
  if (opts.fakeTelegram) middlewares.push(opts.fakeTelegram)

  const storage = new GuardedStorage(paths.sessionFile, deny)
  const tg = new BaseTelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage,
    crypto: new PinnedCryptoProvider(paths.wasmDir),
    platform,
    logger: createLogger(platform, opts.logLevel),
    transport: new TcpTransport(),
    disableUpdates: true,
    updates: false,
    network: { middlewares },
    initConnectionOptions: { deviceModel: 'tg', appVersion: '0.1.0' },
  })

  await tg.prepare()
  // Tests never open a socket: the fake answers inside the middleware chain.
  if (opts.fakeTelegram) (tg as unknown as { _connected: boolean })._connected = true
  const self = await tg.storage.self.fetch()

  let closed = false
  return {
    tg,
    storage,
    selfId: self?.userId ?? null,
    async close() {
      if (closed) return
      closed = true
      try {
        await tg.destroy()
      } finally {
        purgeDenied(paths.sessionFile, deny)
        state.absorb(deny)
        state.save()
      }
    },
  }
}
