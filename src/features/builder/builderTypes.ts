export type BuilderMessage = {
  role: 'user' | 'assistant'
  title: string
  body: string
}

export type AgentStreamEvent =
  | {
      type: 'status' | 'chunk' | 'error'
      message: string
    }
  | {
      type: 'done'
    }
