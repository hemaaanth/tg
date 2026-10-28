import { ToolError } from './errors.js'

// Process hardening shared by both entries. The sudoers rule already
// resets the environment; these checks catch a wrong install.

export function harden(): void {
  process.umask(0o077)
  // No stray console output. Only the JSON line reaches stdout.
  console.log = () => {}
  console.info = () => {}
  console.debug = () => {}
  const uid = process.getuid?.()
  // Root must never run the tool: it would bypass every file check.
  if (uid === undefined || uid === 0) throw new ToolError('config_invalid')
  // --require, --import, --inspect and friends could load other code.
  if (process.execArgv.length > 0) throw new ToolError('config_invalid')
  if (process.env.NODE_OPTIONS !== undefined) throw new ToolError('config_invalid')
}
