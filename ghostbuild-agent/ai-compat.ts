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
  return message.parts
    .map((part) =>
      part.type === 'text' && typeof (part as { text?: string }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('');
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
  const p = part as Record<string, unknown>;
  const approval = isRecord(p.approval)
    ? {
        ...(typeof p.approval.id === 'string' ? { id: p.approval.id } : {}),
        ...(typeof p.approval.approved === 'boolean' ? { approved: p.approval.approved } : {}),
        ...(typeof p.approval.reason === 'string' ? { reason: p.approval.reason } : {}),
      }
    : undefined;
  return {
    ...part,
    type: 'dynamic-tool',
    toolName: typeof p.toolName === 'string' ? p.toolName : part.type.replace(/^tool-/, ''),
    toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : '',
    state: typeof p.state === 'string' ? p.state : 'input-streaming',
    ...(typeof p.errorText === 'string' ? { errorText: p.errorText } : {}),
    approval,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
