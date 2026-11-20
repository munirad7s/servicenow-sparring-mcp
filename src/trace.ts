import { AsyncLocalStorage } from 'node:async_hooks'

/** What one tool call did. Lets every answer say how many requests it cost, and the audit log say which tool asked. */
export interface CallTrace {
  tool: string
  requests: number
}

const calls = new AsyncLocalStorage<CallTrace>()

export function currentCall(): CallTrace | undefined {
  return calls.getStore()
}

/** Wraps a tool handler so that everything it does is attributed to that tool call, also when calls overlap. */
export function traced<Args, Result>(tool: string, handler: (args: Args) => Promise<Result>): (args: Args) => Promise<Result> {
  return (args) => calls.run({ tool, requests: 0 }, () => handler(args))
}
