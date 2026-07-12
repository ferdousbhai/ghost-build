import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session';
import {
  COMPACTION_PREFIX,
  alignBoundaryForward,
  createCompactFunction,
  estimateMessageTokens,
  estimateStringTokens,
  findTailCutByTokens,
} from 'agents/experimental/memory/utils';
import { getToolInvocation, type GhostbuildMessage, type GhostbuildPart } from 'ghostbuild-agent/ai-compat';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS } from 'ghostbuild-agent/context-limits';
/**
 * GLM-5.2 has a 262K context window. Compacting at 100K avoids the quality
 * degradation observed in longer contexts and leaves ample response headroom.
 */
export const AUTO_COMPACTION_TOKEN_THRESHOLD = MAX_ESTIMATED_MODEL_INPUT_TOKENS;

const AUTO_COMPACTION_PROTECTED_HEAD = 3;
const AUTO_COMPACTION_TAIL_TOKENS = 32_000;
const AUTO_COMPACTION_MIN_TAIL_MESSAGES = 4;

const EMERGENCY_TAIL_TOKENS = 48_000;

export type ContextCompaction = {
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  generation: number;
};

type AssembledContext = {
  messages: GhostbuildMessage[];
  overlayApplied: boolean;
};

/**
 * Apply a Cloudflare-style, non-destructive summary overlay at read time.
 * The source transcript is returned unchanged when its end anchor is absent,
 * which prevents a summary from a rewound branch leaking into the new branch.
 */
export function assembleCompactedContext(
  messages: GhostbuildMessage[],
  compaction?: ContextCompaction | null,
): AssembledContext {
  return assembleContext(messages, compaction);
}

function assembleContext(
  messages: GhostbuildMessage[],
  compaction: ContextCompaction | null | undefined,
): AssembledContext {
  if (!compaction) {
    return { messages, overlayApplied: false };
  }

  const endIndex = messages.findIndex((message) => message.id === compaction.toMessageId);
  if (endIndex < 0) {
    return { messages, overlayApplied: false };
  }

  const storedStartIndex = messages.findIndex((message) => message.id === compaction.fromMessageId);
  const startIndex = storedStartIndex < 0 ? 0 : storedStartIndex;
  if (startIndex > endIndex) {
    return { messages, overlayApplied: false };
  }

  const overlay: GhostbuildMessage = {
    id: `${COMPACTION_PREFIX}ghostbuild_${compaction.generation}`,
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: compaction.summary,
      },
    ],
  };

  return {
    messages: [...messages.slice(0, startIndex), overlay, ...messages.slice(endIndex + 1)],
    overlayApplied: true,
  };
}

export function estimateContextTokens(messages: GhostbuildMessage[], systemPrompts: string[] = []): number {
  const messageTokens = estimateMessageTokens(toSessionMessages(messages));
  const systemTokens = systemPrompts.reduce((total, prompt) => total + estimateStringTokens(prompt), 0);
  return messageTokens + systemTokens;
}

export function shouldCompactContext(estimatedTokens: number): boolean {
  return estimatedTokens > AUTO_COMPACTION_TOKEN_THRESHOLD;
}

export async function compactContext(args: {
  messages: GhostbuildMessage[];
  current?: ContextCompaction | null;
  summarize: (prompt: string) => Promise<string>;
}): Promise<ContextCompaction | null> {
  const assembled = assembleContext(args.messages, args.current);
  const compact = createCompactFunction({
    summarize: args.summarize,
    protectHead: AUTO_COMPACTION_PROTECTED_HEAD,
    tailTokenBudget: AUTO_COMPACTION_TAIL_TOKENS,
    minTailMessages: AUTO_COMPACTION_MIN_TAIL_MESSAGES,
  });
  const result = await compact(toSessionMessages(assembled.messages));

  if (!result) {
    return null;
  }

  return {
    summary: result.summary,
    fromMessageId: assembled.overlayApplied && args.current ? args.current.fromMessageId : result.fromMessageId,
    toMessageId: result.toMessageId,
    generation: (args.current?.generation ?? 0) + 1,
  };
}

/**
 * Last-resort, non-persistent prompt window used only when an over-budget
 * summary attempt fails. It keeps the durable transcript intact and retries
 * real compaction on a later turn.
 */
export function createEmergencyContext(messages: GhostbuildMessage[]): GhostbuildMessage[] {
  const sessionMessages = toSessionMessages(messages);
  const headEnd = alignBoundaryForward(sessionMessages, AUTO_COMPACTION_PROTECTED_HEAD);
  const tailStart = findTailCutByTokens(
    sessionMessages,
    headEnd,
    EMERGENCY_TAIL_TOKENS,
    AUTO_COMPACTION_MIN_TAIL_MESSAGES,
  );

  if (tailStart <= headEnd) {
    return messages;
  }

  const marker: GhostbuildMessage = {
    id: `${COMPACTION_PREFIX}ghostbuild_emergency`,
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: 'Earlier conversation turns are temporarily omitted because automatic summary generation was unavailable. The full transcript remains stored.',
      },
    ],
  };

  return [...messages.slice(0, headEnd), marker, ...messages.slice(tailStart)];
}

/** Normalize legacy stored tool parts so Cloudflare can count and align them. */
export function toSessionMessages(messages: GhostbuildMessage[]): SessionMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: message.parts.map(toSessionPart),
  }));
}

function toSessionPart(part: GhostbuildPart): SessionMessagePart {
  if (part.type !== 'tool-invocation') {
    return part as SessionMessagePart;
  }

  const invocation = getToolInvocation(part);
  if (!invocation) {
    return part as SessionMessagePart;
  }

  return {
    type: 'dynamic-tool',
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName,
    state: invocation.state === 'result' ? 'output-available' : 'input-available',
    input: invocation.args,
    ...(invocation.state === 'result' ? { output: invocation.result } : {}),
  };
}
