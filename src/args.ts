import { ToolError } from './errors.js'

// Tiny strict argv parser. Unknown flags are errors.

export interface ParsedArgs {
  verb: string
  positional: string[]
  flags: Record<string, string | true>
}

export function parseArgs(argv: string[], allowed: Record<string, 'value' | 'bool'>): ParsedArgs {
  const [verb, ...rest] = argv
  if (!verb) throw new ToolError('bad_args')
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const kind = allowed[name]
    if (!kind) throw new ToolError('bad_args')
    if (kind === 'bool') {
      flags[name] = true
      continue
    }
    const value = rest[i + 1]
    if (value === undefined) throw new ToolError('bad_args')
    flags[name] = value
    i++
  }
  return { verb, positional, flags }
}

export function intFlag(flags: ParsedArgs['flags'], name: string, min: number, max: number): number | undefined {
  const v = flags[name]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !/^\d{1,10}$/.test(v)) throw new ToolError('bad_args')
  const n = Number(v)
  if (n < min || n > max) throw new ToolError('bad_args')
  return n
}

export const MAX_TEXT = 4096

export function textFlag(flags: ParsedArgs['flags'], name: string): string {
  const v = flags[name]
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_TEXT) throw new ToolError('bad_args')
  return v
}
