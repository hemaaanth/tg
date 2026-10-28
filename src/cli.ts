import { productionPaths } from './config.js'
import { harden } from './harden.js'
import { emitError, runCli } from './run.js'

// Production entry: /usr/bin/node /usr/local/lib/tg/cli.mjs <verb> ...
// Runs as tg through the single sudoers rule.

function finish(code: number, line: string): void {
  process.stdout.write(`${line}\n`, () => process.exit(code))
}

async function main(): Promise<void> {
  let out = ''
  const write = (line: string) => {
    out = line
  }
  let code: number
  try {
    harden()
    code = await runCli(process.argv.slice(2), {
      paths: productionPaths(),
      trust: { configOwnerUid: 0, processUid: process.getuid!() },
      write,
    })
  } catch (err) {
    code = emitError(write, err)
  }
  finish(code, out)
}

void main()
