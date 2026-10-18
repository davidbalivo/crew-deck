export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  /** AgentId of the loop that spawned this run; absent when the main thread did. */
  parentAgentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  /** Tokens sent, cache reads and writes included. Absent on runs recorded before this field existed. */
  inputTokens?: number
  /** Tokens generated. Absent on runs recorded before this field existed. */
  outputTokens?: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  /** Ids of runs that ended well, unfolded by their arrow. Absent in state saved before this field existed. */
  expanded?: string[]
}

/** Where the session works, for the header. */
export type Env = {
  /** Last segment of the session's root. */
  folder: string
  /** The root's parent, with the home directory as `~`. */
  path: string
  /** Current git branch, `@abc1234` on a detached HEAD; absent outside git. */
  branch?: string
}

/** One rate-limit window of the account, as the engine reports it. */
export type Limit = {
  /** `five_hour`, `seven_day` or `spend_limit`. */
  kind: string
  /** How much of the window is used, 0 to 100 (past 100 on an exceeded spend limit). */
  pct: number
}

/** The main thread: its model, its context and what its own requests used. */
export type Main = {
  model?: string
  effort?: string
  /** Input tokens of the last response; absent before the first response. */
  ctxTokens?: number
  /** The model's context window, in tokens. */
  ctxWindow?: number
  /** `ctxTokens` over `ctxWindow`, 0 to 100; absent before the first response. */
  ctxPct?: number
  /** Tokens sent (cache reads and writes included) plus tokens generated. */
  tokens: number
  inputTokens: number
  outputTokens: number
  /** Estimated from `PRICES`, as for the subagents. */
  costUsd: number
  /** Empty off a subscription or before the first reading. */
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'crew-deck': {
      agents: AgentRun[]
      panel: Panel
      now: number
      env: Env
      main: Main
    }
  }
}
