import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type UIMessage,
  type UIMessagePart,
  type UITools,
} from 'ai';

export type PendingDeploymentApproval = {
  id: string;
  planDigest: string;
  resources: Array<{ type: string; logicalName: string; proposedName: string }>;
};

export type GhostbuildDataTypes = {
  'deployment-approval': PendingDeploymentApproval;
};

export type GhostbuildPart = UIMessagePart<GhostbuildDataTypes, UITools>;
export type GhostbuildToolInvocation = DynamicToolUIPart;

export type GhostbuildMessage = UIMessage<unknown, GhostbuildDataTypes, UITools> & {
  createdAt?: Date | number | string;
};

export function messageText(message: Pick<GhostbuildMessage, 'parts'>): string {
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
  for (const key of [
    'cachedPromptTokens',
    'cachedInputTokens',
    'cacheReadInputTokens',
    'cacheReadTokens',
    'cacheRead',
  ]) {
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

export function isToolPart(part: GhostbuildPart): boolean {
  return isToolUIPart(part);
}

export function getToolInvocation(part: GhostbuildPart): GhostbuildToolInvocation | null {
  if (!isToolUIPart(part)) {
    return null;
  }
  if (part.type === 'dynamic-tool') {
    return part;
  }
  return {
    ...part,
    type: 'dynamic-tool',
    toolName: getToolName(part),
  } as GhostbuildToolInvocation;
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
