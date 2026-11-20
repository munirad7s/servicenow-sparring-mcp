export type ErrorKind =
  | 'config'
  | 'validation'
  | 'blocked'
  | 'auth'
  | 'acl'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'too_large'
  | 'invalid_response'
  | 'unknown'

export class ServiceNowError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly table?: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ServiceNowError'
  }
}

export function validation(message: string, table?: string): ServiceNowError {
  return new ServiceNowError(message, 'validation', table)
}

/** Failures that say the instance could not be used at all, as opposed to one table being closed or unreadable. */
export const NO_CONNECTION: ReadonlySet<string> = new Set(['auth', 'network', 'timeout', 'redirect', 'invalid_response', 'rate_limited'])

const ABOUT_ONE_ANSWER = new WeakSet<Error>()

/**
 * An answer that came back and cannot be used for what was asked: the definition of one view, the parents of one
 * table. Of the same kind as an answer that is no JSON at all, but it says nothing about the connection.
 */
export function unusableAnswer(message: string, table: string): ServiceNowError {
  const error = new ServiceNowError(message, 'invalid_response', table)
  ABOUT_ONE_ANSWER.add(error)
  return error
}

/**
 * true if a failure says that the instance could not be used at all: the login was rejected, the host did not
 * answer, the answer was no JSON. Nothing is known about any table then, so the failure is passed on as it is and
 * not turned into "this table is closed" or "the dictionary could not be read".
 */
export function noConnection(error: unknown): boolean {
  return error instanceof ServiceNowError && NO_CONNECTION.has(error.kind) && !ABOUT_ONE_ANSWER.has(error)
}

/**
 * Text that came from the instance and ends up in a message: one line, bounded,
 * without control characters. It is quoted as data wherever it is shown.
 */
export function quoteInstanceText(text: unknown, max = 300): string {
  const clean = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}
