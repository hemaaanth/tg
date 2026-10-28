import { LogManager } from '@mtcute/core/utils.js'
import type { ICorePlatform } from '@mtcute/core'

// mtcute formats log lines itself and can inline whole TL objects
// (names, message text) with %j. So the handler never prints the format
// string or its arguments. It prints the level and the logger tag only.
// The level is pinned; MTCUTE_LOG_LEVEL is ignored.

export type LogSink = (line: string) => void

const LEVELS = ['', 'error', 'warn', 'info', 'debug', 'verbose']

export const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`)
}

export class SafePlatform implements ICorePlatform {
  constructor(
    private readonly sink: LogSink = stderrSink,
    private readonly level: number = LogManager.WARN,
  ) {}

  log(_color: number, level: number, tag: string, _fmt: string, _args: unknown[]): void {
    const safeTag = /^[a-z0-9_.-]{1,32}$/i.test(tag) ? tag : 'mtcute'
    this.sink(`tg: mtcute ${LEVELS[level] ?? 'log'} [${safeTag}] (details withheld)`)
  }

  beforeExit(): () => void {
    // The CLI closes the client itself. No global exit hooks.
    return () => {}
  }

  getDefaultLogLevel(): number {
    return this.level
  }

  getDeviceModel(): string {
    return 'tg'
  }
}

export function createLogger(platform: SafePlatform, level: number = LogManager.WARN): LogManager {
  const log = new LogManager('client', platform)
  log.level = level
  return log
}
