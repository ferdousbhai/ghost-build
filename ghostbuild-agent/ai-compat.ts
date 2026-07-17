import { type UIDataTypes, type UIMessage, type UIMessagePart, type UITools } from 'ai';

export type GhostbuildToolInvocation = {
  state: 'partial-call' | 'call' | 'result';
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
};

type StoredToolInvocationPart = {
  type: 'tool-invocation';
  toolInvocation: GhostbuildToolInvocation;
};

type AiSdkToolPartRecord = {
  toolName?: unknown;
  toolCallId?: unknown;
  state?: unknown;
  input?: unknown;
  output?: unknown;
  errorText?: unknown;
};

export type GhostbuildPart = UIMessagePart<UIDataTypes, UITools> | StoredToolInvocationPart;

type GhostbuildToolPart = GhostbuildPart & {
  type: 'tool-invocation' | 'dynamic-tool' | `tool-${string}`;
};

export type GhostbuildMessage = Omit<UIMessage, 'parts'> & {
  parts: GhostbuildPart[];
  content?: string;
  createdAt?: Date | number | string;
};

export function messageText(message: Pick<GhostbuildMessage, 'content' | 'parts'>): string {
  if (typeof message.content === 'string' && message.content.length > 0) {
    return message.content;
  }
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
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

export function cachedPromptTokens(metadata?: unknown): number {
  return cachedPromptTokenCount(metadata) ?? 0;
}

export function cachedPromptTokenCount(metadata?: unknown): number | undefined {
  return findNumericCacheRead(metadata, new WeakSet());
}

export function languageModelId(model: unknown, fallback: string): string {
  const modelId = (model as { modelId?: unknown } | null | undefined)?.modelId;
  return typeof modelId === 'string' && modelId.length > 0 ? modelId : fallback;
}

function findNumericCacheRead(value: unknown, seen: WeakSet<object>): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  let observedZero = false;
  for (const key of ['cachedPromptTokens', 'cachedInputTokens', 'cacheReadInputTokens', 'cacheRead']) {
    const candidate = record[key];
    if (isPositiveSafeInteger(candidate)) {
      return candidate;
    }
    observedZero ||= candidate === 0;
  }

  const promptTokenDetails = record.prompt_tokens_details;
  if (promptTokenDetails && typeof promptTokenDetails === 'object') {
    const cachedTokens = (promptTokenDetails as Record<string, unknown>).cached_tokens;
    if (isPositiveSafeInteger(cachedTokens)) {
      return cachedTokens;
    }
    observedZero ||= cachedTokens === 0;
  }

  for (const candidate of Object.values(record)) {
    const nested = findNumericCacheRead(candidate, seen);
    if (nested !== undefined && nested > 0) {
      return nested;
    }
    observedZero ||= nested === 0;
  }

  return observedZero ? 0 : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isStoredToolInvocationPart(part: GhostbuildPart): part is StoredToolInvocationPart {
  return part.type === 'tool-invocation';
}

export function isToolPart(part: GhostbuildPart): part is GhostbuildToolPart {
  return (
    !isMisparsedArtifactToolPart(part) &&
    (isStoredToolInvocationPart(part) || part.type === 'dynamic-tool' || part.type.startsWith('tool-'))
  );
}

export function isMisparsedArtifactToolPart(part: GhostbuildPart): boolean {
  return typeof part.type === 'string' && part.type.startsWith('tool-boltArtifact');
}

export function getToolInvocation(part: GhostbuildPart): GhostbuildToolInvocation | null {
  if (isStoredToolInvocationPart(part)) {
    return part.toolInvocation;
  }
  if (part.type !== 'dynamic-tool' && !part.type.startsWith('tool-')) {
    return null;
  }

  const toolPart = part as unknown as AiSdkToolPartRecord;
  const toolName =
    part.type === 'dynamic-tool' && typeof toolPart.toolName === 'string'
      ? toolPart.toolName
      : part.type.slice('tool-'.length);
  const toolCallId = typeof toolPart.toolCallId === 'string' ? toolPart.toolCallId : '';
  const args = toolPart.input;
  const base = {
    toolCallId,
    toolName,
    args,
  };

  if (toolPart.state === 'input-streaming') {
    return { ...base, state: 'partial-call' };
  }
  if (
    toolPart.state === 'input-available' ||
    toolPart.state === 'approval-requested' ||
    toolPart.state === 'approval-responded'
  ) {
    return { ...base, state: 'call' };
  }
  if (toolPart.state === 'output-error') {
    const errorText = typeof toolPart.errorText === 'string' ? toolPart.errorText : 'Tool output failed.';
    return { ...base, state: 'result', result: `Error: ${errorText}` };
  }
  if (toolPart.state === 'output-denied') {
    return { ...base, state: 'result', result: 'Error: Tool output denied.' };
  }
  return { ...base, state: 'result', result: toolPart.output };
}

export function isToolResult(part: GhostbuildPart): boolean {
  return getToolInvocation(part)?.state === 'result';
}

export function isToolInvocationInProgress(invocation: Pick<GhostbuildToolInvocation, 'state'>): boolean {
  return invocation.state === 'partial-call' || invocation.state === 'call';
}
