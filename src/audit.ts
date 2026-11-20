import { appendFile } from 'node:fs'
import type { AuditEntry } from './client.js'

/**
 * Writes one JSON line per request to a local file, so that a person can see
 * afterwards what an agent asked the instance: tool, table, query, status and
 * row counts. Never credentials, never record content.
 *
 * A log that cannot be written must not break a tool call: the first failure is
 * reported once on stderr.
 */
export function auditWriter(path: string, report: (message: string) => void = console.error): (entry: AuditEntry) => void {
  let failed = false
  return (entry) => {
    appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 }, (error) => {
      if (error && !failed) {
        failed = true
        report(`audit log: cannot write to ${path} (${error.code ?? error.name})`)
      }
    })
  }
}
