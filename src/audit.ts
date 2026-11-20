import { appendFile } from 'node:fs/promises'
import type { AuditEntry } from './client.js'

/**
 * Writes one JSON line per request to a local file, so that a person can see
 * afterwards what an agent asked the instance: tool, table, query, status and
 * row counts. Never credentials, never record content.
 *
 * The lines are written one after the other, so they stand in the order the
 * requests ended. A log that cannot be written must not break a tool call: the
 * first failure is reported once on stderr.
 */
export function auditWriter(path: string, report: (message: string) => void = console.error): (entry: AuditEntry) => void {
  let failed = false
  let written: Promise<void> = Promise.resolve()
  return (entry) => {
    const line = `${JSON.stringify(entry)}\n`
    written = written
      .then(() => appendFile(path, line, { mode: 0o600 }))
      .catch((error: NodeJS.ErrnoException) => {
        if (failed) return
        failed = true
        report(`audit log: cannot write to ${path} (${error.code ?? error.name})`)
      })
  }
}
