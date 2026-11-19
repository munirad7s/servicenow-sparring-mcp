export type ErrorKind =
  | 'config'
  | 'validation'
  | 'auth'
  | 'acl'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'timeout'
  | 'network'
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
