import { appendFile } from 'node:fs/promises'
import type { AuditEntry } from './client.js'

/** As many lines as may wait to be written. Beyond that a line is dropped, and the log says how many were. */
const MAX_WAITING = 10_000

/**
 * Writes one JSON line per request to a local file, so that a person can see
 * afterwards what an agent asked the instance: tool, table, query, status and
 * row counts. Never credentials, never record content.
 *
 * The lines are written one after the other, so they stand in the order the
 * requests ended. A log that cannot be written must not break a tool call: the
 * first failure is reported once on stderr. A file that takes no lines for a
 * while must not fill the memory of the server either: beyond ten thousand
 * waiting lines the new ones are dropped, and a line in their place says how
 * many were lost.
 */
export function auditWriter(
  path: string,
  report: (message: string) => void = console.error,
  append: (path: string, line: string, options: { mode: number }) => Promise<void> = appendFile,
): (entry: AuditEntry) => void {
  let failed = false
  let slow = false
  let waiting = 0
  let dropped = 0
  let written: Promise<void> = Promise.resolve()
  const write = (line: string) =>
    append(path, line, { mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (failed) return
      failed = true
      report(`audit log: cannot write to ${path} (${error.code ?? error.name})`)
    })
  return (entry) => {
    if (waiting >= MAX_WAITING) {
      if (!dropped) {
        // Said once, like a file that cannot be written. The log itself says each time how many lines it lost.
        if (!slow) report(`audit log: ${path} is not taking lines fast enough, and new ones are dropped until it does`)
        slow = true
        // Behind the lines that wait, where the dropped ones would have stood: how many were lost by then.
        written = written.then(async () => {
          const lost = dropped
          dropped = 0
          await write(`${JSON.stringify({ time: new Date().toISOString(), dropped: lost })}\n`)
        })
      }
      dropped++
      return
    }
    waiting++
    const line = `${JSON.stringify(entry)}\n`
    written = written.then(async () => {
      await write(line)
      waiting--
    })
  }
}
