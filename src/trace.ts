import { AsyncLocalStorage } from 'node:async_hooks'

/** What one tool call did. Lets every answer say how many requests it cost, and the audit log say which tool asked. */
export interface CallTrace {
  tool: string
  /** When the call began, in milliseconds. A call that runs for minutes is ended. */
  started: number
  requests: number
  /** What the gate of closed tables did to the requests of this call. Every answer passes it on as warnings. */
  closed: { rowsLeftOut: boolean; names: Set<string>; untold: Set<string>; copies: Set<string> }
  /**
   * The failure that ends this call, whatever the tool does with it: the login was rejected, the instance could
   * not be reached, or the call sent as many requests as one call may. A tool that catches such a failure where
   * it only meant to catch "this table is not readable" does not turn it into an answer.
   */
  ended?: Error
}

const calls = new AsyncLocalStorage<CallTrace>()

export function currentCall(): CallTrace | undefined {
  return calls.getStore()
}

/** Wraps a tool handler so that everything it does is attributed to that tool call, also when calls overlap. */
export function traced<Args, Result>(tool: string, handler: (args: Args) => Promise<Result>): (args: Args) => Promise<Result> {
  return (args) => calls.run({ tool, started: Date.now(), requests: 0, closed: { rowsLeftOut: false, names: new Set(), untold: new Set(), copies: new Set() } }, () => handler(args))
}
