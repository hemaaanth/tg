import { createInterface } from 'node:readline'
import { type Prompt, runAdmin } from './admin.js'
import { productionPaths } from './config.js'
import { errorPayload } from './errors.js'
import { harden } from './harden.js'
import { toToolError } from './run.js'

// Admin entry: /usr/bin/node /usr/local/lib/tg/admin.mjs <verb> ...
// Not in sudoers. Root runs it through setup/tg-admin as tg.

function readSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) return reject(new Error('no tty'))
    process.stderr.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const done = (err?: Error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stderr.write('\n')
      if (err) reject(err)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done()
        if (ch === '\u0003') return done(new Error('cancelled'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

const ttyPrompt: Prompt = {
  async ask(question, secret) {
    if (!process.stdin.isTTY) throw new Error('no tty')
    if (secret) return readSecret(question)
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      return await new Promise<string>((resolve) => rl.question(question, resolve))
    } finally {
      rl.close()
    }
  },
  say(line) {
    process.stderr.write(`${line}\n`)
  },
}

async function main(): Promise<void> {
  let code = 0
  try {
    harden()
    code = await runAdmin(process.argv.slice(2), {
      paths: productionPaths(),
      trust: { configOwnerUid: 0, processUid: process.getuid!() },
      prompt: ttyPrompt,
    })
  } catch (err) {
    const e = toToolError(err)
    process.stderr.write(`tg-admin: ${JSON.stringify(errorPayload(e))}\n`)
    code = 1
  }
  process.stdout.write('', () => process.exit(code))
}

void main()
