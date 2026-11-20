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
