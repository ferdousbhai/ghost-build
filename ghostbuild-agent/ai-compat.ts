// Pi-native ghost message — kept structurally compatible with UIMessage parts shapes used by chat UI.
export type GhostbuildPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool-read';
      toolCallId: string;
      toolName: string;
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    }
  | {
      type: 'tool-write';
      toolCallId: string;
      toolName: string;
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    }
  | {
      type: 'tool-edit';
      toolCallId: string;
      toolName: string;
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    }
  | {
      type: 'tool-exec';
      toolCallId: string;
      toolName: string;
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    }
  | {
      type: 'tool-cloudflare_docs' | 'tool-cloudflare_search' | 'tool-cloudflare_execute';
      toolCallId: string;
      toolName: 'cloudflare_docs' | 'cloudflare_search' | 'cloudflare_execute';
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    }
  | ({
      type: 'dynamic-tool';
      toolName: string;
      toolCallId: string;
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    } & Record<string, unknown>)
  | ({
      type: string;
      text?: string;
      toolName?: string;
      toolCallId?: string;
      state?: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      approval?: unknown;
      data?: unknown;
      url?: unknown;
      mediaType?: unknown;
      title?: unknown;
    } & Record<string, unknown>);

export type GhostbuildToolInvocation = {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string; approved?: boolean; reason?: string };
} & Record<string, unknown>;

export type GhostbuildMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: GhostbuildPart[];
  metadata?: unknown;
  createdAt?: Date | number | string;
};

export function messageText(message: Pick<GhostbuildMessage, 'parts'>): string {
  return message.parts.map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
}

export function createdAtMillis(message: Pick<GhostbuildMessage, 'createdAt'>): number | undefined {
  const { createdAt } = message;
  if (createdAt instanceof Date) {
    return createdAt.getTime();
  }
  if (typeof createdAt === 'number') {
    return createdAt;
  }
  if (typeof createdAt === 'string') {
    const timestamp = Date.parse(createdAt);
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  return undefined;
}

export function isToolPart(part: GhostbuildPart): boolean {
  return typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool');
}

export function getToolInvocation(part: GhostbuildPart): GhostbuildToolInvocation | null {
  if (!isToolPart(part)) {
    return null;
  }
  const fields: ToolInvocationFields = part;
  const invocation: GhostbuildToolInvocation = {
    ...part,
    type: 'dynamic-tool',
    toolName: typeof fields.toolName === 'string' ? fields.toolName : part.type.replace(/^tool-/, ''),
    toolCallId: typeof fields.toolCallId === 'string' ? fields.toolCallId : '',
    state: typeof fields.state === 'string' ? fields.state : 'input-streaming',
    approval: toolApproval(fields.approval),
  };
  if (typeof fields.errorText === 'string') {
    invocation.errorText = fields.errorText;
  }
  return invocation;
}

export function isToolResult(part: GhostbuildPart): boolean {
  const state = getToolInvocation(part)?.state;
  return state === 'output-available' || state === 'output-error' || state === 'output-denied';
}

export function isToolInvocationInProgress(invocation: Pick<GhostbuildToolInvocation, 'state'>): boolean {
  return (
    invocation.state === 'input-streaming' ||
    invocation.state === 'input-available' ||
    invocation.state === 'approval-requested' ||
    invocation.state === 'approval-responded'
  );
}

/** The tool-carrying fields a part may expose, before any of them are known to be well-formed. */
type ToolInvocationFields = {
  type: string;
  toolName?: unknown;
  toolCallId?: unknown;
  state?: unknown;
  errorText?: unknown;
  approval?: unknown;
};

type ToolApproval = NonNullable<GhostbuildToolInvocation['approval']>;

function toolApproval(value: unknown): ToolApproval | undefined {
  if (!isApprovalFields(value)) {
    return undefined;
  }
  const approval: ToolApproval = {};
  if (typeof value.id === 'string') {
    approval.id = value.id;
  }
  if (typeof value.approved === 'boolean') {
    approval.approved = value.approved;
  }
  if (typeof value.reason === 'string') {
    approval.reason = value.reason;
  }
  return approval;
}

function isApprovalFields(value: unknown): value is { id?: unknown; approved?: unknown; reason?: unknown } {
  return typeof value === 'object' && value !== null;
}
