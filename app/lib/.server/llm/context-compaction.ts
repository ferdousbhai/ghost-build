import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session';
import { COMPACTION_PREFIX, createCompactFunction } from 'agents/experimental/memory/utils';
import { getToolInvocation, type GhostbuildMessage, type GhostbuildPart } from 'ghostbuild-agent/ai-compat';

const AUTO_COMPACTION_PROTECTED_HEAD = 3;
const AUTO_COMPACTION_TAIL_TOKENS = 32_000;
const AUTO_COMPACTION_MIN_TAIL_MESSAGES = 4;

export type ContextCompaction = {
  summary: string;
  fromMessageId: string;
  toMessageId: string;
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
    id: `${COMPACTION_PREFIX}ghostbuild_${compaction.toMessageId}`,
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

export async function compactContext(args: {
  messages: GhostbuildMessage[];
  current?: ContextCompaction | null;
  summarize: (prompt: string) => Promise<string>;
}): Promise<ContextCompaction | null> {
  const assembled = assembleCompactedContext(args.messages, args.current);
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
  };
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
