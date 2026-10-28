import type { RpcCallMiddleware } from '@mtcute/core'
import { ToolError } from './errors.js'
import type { StateStore } from './state.js'
import { DAY_MS } from './state.js'

// Rate limits. Telegram flood deadlines are persisted, so a new process
// never retries early. Each method also has a per-run budget and a minimum
// gap between calls.

export interface Budget {
  max: number
  minIntervalMs: number
}

export const BUDGETS: Record<string, Budget> = {
  'messages.getDialogs': { max: Number.POSITIVE_INFINITY, minIntervalMs: 2000 },
  'messages.getHistory': { max: 30, minIntervalMs: 1000 },
  'messages.searchGlobal': { max: 1, minIntervalMs: 2000 },
  'messages.search': { max: 1, minIntervalMs: 1000 },
  'messages.getCommonChats': { max: 50, minIntervalMs: 2000 },
  'channels.getParticipant': { max: 60, minIntervalMs: 1000 },
  'messages.getFullChat': { max: 30, minIntervalMs: 1000 },
  'contacts.getContacts': { max: 1, minIntervalMs: 2000 },
  'contacts.resolveUsername': { max: 1, minIntervalMs: 2000 },
  'messages.getPeerDialogs': { max: 1, minIntervalMs: 1000 },
  'messages.saveDraft': { max: 1, minIntervalMs: 5000 },
  'messages.readHistory': { max: 1, minIntervalMs: 1000 },
  'channels.readHistory': { max: 1, minIntervalMs: 1000 },
  'messages.readMentions': { max: 1, minIntervalMs: 1000 },
  'folders.editPeerFolders': { max: 1, minIntervalMs: 1000 },
  'messages.sendMessage': { max: 1, minIntervalMs: 10_000 },
  'messages.addChatUser': { max: 1, minIntervalMs: 180_000 },
  'channels.inviteToChannel': { max: 1, minIntervalMs: 180_000 },
  'auth.sendCode': { max: 1, minIntervalMs: 60_000 },
}

/** Waits up to this long in-process. Longer waits abort the run. */
export const SHORT_WAIT_S = 10
/** A wait longer than this trips the 24 h breaker for every method. */
export const BREAKER_WAIT_S = 3600

const FLOOD_RE = /^(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT)_(\d+)$/

export interface FloodDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  budgets?: Record<string, Budget>
}

function floodSeconds(res: unknown): number | null {
  if (typeof res !== 'object' || res === null) return null
  const r = res as { _?: string; errorMessage?: string }
  if (r._ !== 'mt_rpc_error' || typeof r.errorMessage !== 'string') return null
  const m = FLOOD_RE.exec(r.errorMessage)
  return m ? Number(m[1]) : null
}

export function floodGuard(state: StateStore, deps: FloodDeps = {}): RpcCallMiddleware {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const budgets = deps.budgets ?? BUDGETS
  const used = new Map<string, number>()

  const cooldown = (until: number): ToolError =>
    new ToolError('cooldown', { until: new Date(until).toISOString(), rpc: 'FLOOD_WAIT' })

  return async (ctx, next) => {
    const method = ctx.request._ as string
    const budgetKey = method === 'messages.addChatUser' || method === 'channels.inviteToChannel' ? 'workInvite' : method
    const data = state.data
    const t = now()
    if (data.breakerUntil && data.breakerUntil > t) throw cooldown(data.breakerUntil)
    const until = data.cooldowns[method]
    if (until && until > t) throw cooldown(until)

    const budget = budgets[method]
    if (budget) {
      const count = used.get(budgetKey) ?? 0
      if (count >= budget.max) throw new ToolError('budget')
      const last = data.lastCallAt[budgetKey] ?? 0
      const gap = last + budget.minIntervalMs - now()
      if (gap > 0) await sleep(gap)
      used.set(budgetKey, count + 1)
      data.lastCallAt[budgetKey] = now()
    }

    let res = await next(ctx)
    let secs = floodSeconds(res)
    if (secs !== null && secs <= SHORT_WAIT_S) {
      await sleep(secs * 1000 + 500)
      res = await next(ctx)
      secs = floodSeconds(res)
    }
    if (secs !== null) {
      const deadline = now() + secs * 1000
      data.cooldowns[method] = deadline
      if (secs > BREAKER_WAIT_S) data.breakerUntil = now() + DAY_MS
      state.save()
      throw cooldown(data.breakerUntil && data.breakerUntil > deadline ? data.breakerUntil : deadline)
    }
    return res
  }
}

/** Latest active deadline, for the status verb. */
export function activeCooldown(state: StateStore, now = Date.now()): string | null {
  let max = 0
  if (state.data.breakerUntil && state.data.breakerUntil > now) max = state.data.breakerUntil
  for (const until of Object.values(state.data.cooldowns)) if (until > now && until > max) max = until
  return max ? new Date(max).toISOString() : null
}
