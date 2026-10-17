export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

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
  autoOpenedFor: string
}

/** Where the session works and how full its context is, for the header. */
export type Env = {
  /** Last segment of the session's root. */
  folder: string
  /** The root's parent, with the home directory as `~`. */
  path: string
  /** Current git branch, `@abc1234` on a detached HEAD; absent outside git. */
  branch?: string
  /** Main thread's context use, 0 to 100; absent before the first response. */
  ctxPct?: number
}

declare module 'claude-code' {
  interface PluginState {
    'crew-deck': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      env: Env
    }
  }
}
