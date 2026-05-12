export type BuilderMessage = {
  role: 'user' | 'assistant' | 'system'
  title: string
  body: string
}

export type AgentStreamEvent =
  | {
      type: 'status' | 'transcript_delta'
      message: string
    }
  | {
      type: 'tool_event'
      toolName: string
      message: string
    }
  | {
      type: 'approval_request'
      approvalId: string
      action: string
      resource: string
      risk: 'low' | 'medium' | 'high'
      estimatedCost?: string
    }
  | {
      type: 'completion'
      billingSummary: string
    }
  | {
      type: 'error'
      message: string
      terminal: true
    }
