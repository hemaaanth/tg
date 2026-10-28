import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdmin } from '../src/admin.js'
import { type Paths, type Trust, pathsFor } from '../src/config.js'
import type { Denylist } from '../src/deny-set.js'
import type { FloodDeps } from '../src/flood.js'
import { runCli } from '../src/run.js'
import { DENIED, FakeTelegram } from './fake-telegram.js'

export const WASM_DIR = join(import.meta.dirname, '..', 'node_modules', '@mtcute', 'wasm')
export const VERBOSE = 5

export interface Env {
  root: string
  paths: Paths
  trust: Trust
  fake: FakeTelegram
  logs: string[]
  clock: { t: number }
  flood: FloodDeps
}

export function baseConfig(extra: Record<string, unknown> = {}) {
  return { apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef', ...extra }
}

export function baseDenylist(fake: FakeTelegram, extra: Partial<Denylist> = {}): Denylist {
  return {
    version: 1,
    users: [
      {
        id: DENIED,
        accessHash: fake.users.get(DENIED)!.hash.toString(),
        note: 'test',
        redact: ['CANARY Mallory', 'canarymal'],
      },
    ],
    chats: [],
    allowChats: [],
    ...extra,
  }
}

export function makeEnv(opts: { config?: Record<string, unknown>; denylist?: (f: FakeTelegram) => Denylist } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'tg-test-'))
  const configDir = join(root, 'etc')
  const stateDir = join(root, 'var')
  mkdirSync(configDir, { mode: 0o750 })
  mkdirSync(stateDir, { mode: 0o700 })
  chmodSync(configDir, 0o750)
  chmodSync(stateDir, 0o700)
  const paths = pathsFor(configDir, stateDir, WASM_DIR)
  const fake = new FakeTelegram()
  writeJson(paths.configFile, baseConfig(opts.config))
  writeJson(paths.denylistFile, (opts.denylist ?? baseDenylist)(fake))
  const uid = process.getuid!()
  const clock = { t: Date.parse('2026-09-28T12:00:00Z') }
  return {
    root,
    paths,
    trust: { configOwnerUid: uid, processUid: uid },
    fake,
    logs: [],
    clock,
    flood: {
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms
      },
    },
  }
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), { mode: 0o640 })
  chmodSync(file, 0o640)
}

export interface CliResult {
  code: number
  json: Record<string, any>
  raw: string
}

export async function cli(env: Env, ...argv: string[]): Promise<CliResult> {
  let raw = ''
  const code = await runCli(argv, {
    paths: env.paths,
    trust: env.trust,
    now: () => env.clock.t,
    logSink: (line) => env.logs.push(line),
    logLevel: VERBOSE,
    flood: env.flood,
    fakeTelegram: env.fake.middleware(),
    lockWaitMs: 0,
    write: (line) => {
      raw += line
    },
  })
  return { code, json: JSON.parse(raw), raw }
}

export async function admin(env: Env, answers: string[], ...argv: string[]): Promise<{ code: number; out: string; said: string[] }> {
  let out = ''
  const said: string[] = []
  const queue = [...answers]
  const code = await runAdmin(argv, {
    paths: env.paths,
    trust: env.trust,
    prompt: {
      ask: async () => queue.shift() ?? '',
      say: (line) => said.push(line),
    },
    write: (text) => {
      out += text
    },
    logSink: (line) => env.logs.push(line),
    logLevel: VERBOSE,
    flood: env.flood,
    fakeTelegram: env.fake.middleware(),
  })
  return { code, out, said }
}

export async function loggedInEnv(opts: Parameters<typeof makeEnv>[0] = {}): Promise<Env> {
  const env = makeEnv(opts)
  const r = await admin(env, ['+15550000000', '12345'], 'login')
  if (r.code !== 0) throw new Error('login failed')
  env.fake.calls.length = 0
  return env
}

export function sessionBytes(env: Env): Buffer {
  return readFileSync(env.paths.sessionFile)
}

export function stateText(env: Env): string {
  return readFileSync(env.paths.stateFile, 'utf8')
}
