import type {
  Message as PiMessage,
  AssistantMessage as PiAssistantMessage,
  TextContent as PiTextContent,
  ToolCall as PiToolCall,
  Usage as PiUsage,
} from '@earendil-works/pi-ai';
import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core';

// Ghostbuild now canonicalizes on Pi harness types (mirrors workshop-backend).
// UIMessage compatibility shim is retained during strangler for frontend hooks that still
// consume UIMessage-shaped parts; new code should prefer PiMessage / PiAgentEvent.

export type PendingDeploymentApproval = {
  id: string;
  planDigest: string;
  resources: Array<{ type: string; logicalName: string; proposedName: string }>;
};

export type GhostbuildDataTypes = {
  'deployment-approval': PendingDeploymentApproval;
};

// Pi-native ghost message — kept structurally compatible with UIMessage parts shapes used by chat UI.
export type GhostbuildPart =
  | { type: 'text'; text: string }
  | { type: 'tool-read'; toolCallId: string; toolName: string; state: string; input?: unknown; output?: unknown; errorText?: string }
  | { type: 'tool-write'; toolCallId: string; toolName: string; state: string; input?: unknown; output?: unknown; errorText?: string }
  | { type: 'tool-edit'; toolCallId: string; toolName: string; state: string; input?: unknown; output?: unknown; errorText?: string }
  | { type: 'tool-exec'; toolCallId: string; toolName: string; state: string; input?: unknown; output?: unknown; errorText?: string }
  | ({ type: 'dynamic-tool'; toolName: string; toolCallId: string; state: string; input?: unknown; output?: unknown; errorText?: string } & Record<string, unknown>)
  | ({ type: string; text?: string; toolName?: string; toolCallId?: string; state?: string } & Record<string, unknown>);

export type GhostbuildToolInvocation = Extract<GhostbuildPart, { type: 'dynamic-tool' }> & {
  toolName: string;
  toolCallId: string;
  state: string;
};

export type GhostbuildMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: GhostbuildPart[];
  metadata?: unknown;
  createdAt?: Date | number | string;
};

// Re-export Pi primitives for callers migrating off ai SDK
export type { PiMessage, PiAssistantMessage, PiTextContent, PiToolCall, PiUsage, PiAgentEvent };

export function messageText(message: Pick<GhostbuildMessage, 'parts'>): string {
  return message.parts.map((part) => (part.type === 'text' && typeof (part as { text?: string }).text === 'string' ? (part as { text: string }).text : '')).join('');
}

export function createdAtMillis(message: Pick<GhostbuildMessage, 'createdAt'>): number | undefined {
  const { createdAt } = message;
  if (createdAt instanceof Date) return createdAt.getTime();
  if (typeof createdAt === 'number') return createdAt;
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
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  let observedZero = false;
  for (const key of ['cachedPromptTokens', 'cachedInputTokens', 'cacheReadInputTokens', 'cacheReadTokens', 'cacheRead']) {
    const candidate = record[key];
    if (isPositiveSafeInteger(candidate)) return candidate;
    observedZero ||= candidate === 0;
  }
  const promptTokenDetails = record.prompt_tokens_details;
  if (promptTokenDetails && typeof promptTokenDetails === 'object') {
    const cachedTokens = (promptTokenDetails as Record<string, unknown>).cached_tokens;
    if (isPositiveSafeInteger(cachedTokens)) return cachedTokens;
    observedZero ||= cachedTokens === 0;
  }
  for (const candidate of Object.values(record)) {
    const nested = findNumericCacheRead(candidate, seen);
    if (nested !== undefined && nested > 0) return nested;
    observedZero ||= nested === 0;
  }
  return observedZero ? 0 : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// Lightweight tool helpers — no longer depend on ai's isToolUIPart/getToolName
export function isToolPart(part: GhostbuildPart): boolean {
  return typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool');
}

export function getToolInvocation(part: GhostbuildPart): GhostbuildToolInvocation | null {
  if (!isToolPart(part)) return null;
  const p = part as Record<string, unknown>;
  if (part.type === 'dynamic-tool') return part as GhostbuildToolInvocation;
  return {
    ...part,
    type: 'dynamic-tool',
    toolName: (p.toolName as string) ?? (p.type as string).replace(/^tool-/, ''),
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

// Compatibility helper: convert legacy UIMessage shape (from ai) to GhostbuildMessage
export function fromUIMessage(message: unknown): GhostbuildMessage {
  return message as GhostbuildMessage;
}

// Pi Message -> GhostbuildMessage text helper
export function piMessageText(piMessage: PiMessage): string {
  if (piMessage.role === 'user' && typeof piMessage.content === 'string') return piMessage.content;
  if ('content' in piMessage && Array.isArray((piMessage as PiAssistantMessage).content)) {
    return ((piMessage as PiAssistantMessage).content as Array<PiTextContent | PiToolCall>)
      .filter((b) => (b as { type: string }).type === 'text')
      .map((b) => (b as PiTextContent).text)
      .join('');
  }
  if (typeof (piMessage as { content?: unknown }).content === 'string') return (piMessage as { content: string }).content;
  return '';
}
