import { getToolInvocation, type GhostbuildMessage, type GhostbuildPart } from './ai-compat.js';

export type PromptCharacterCounts = {
  messageHistoryChars: number;
  currentTurnChars: number;
  totalPromptChars: number;
};

export function calculatePromptCharacterCounts(
  messages: GhostbuildMessage[],
  systemPrompts: string[] = [],
): PromptCharacterCounts {
  const currentTurnIndex = messages.at(-1)?.role === 'user' ? messages.length - 1 : -1;
  let messageHistoryChars = 0;
  let currentTurnChars = 0;

  messages.forEach((message, index) => {
    const size = messageCharacterCount(message);
    if (index === currentTurnIndex) {
      currentTurnChars += size;
    } else {
      messageHistoryChars += size;
    }
  });

  const systemPromptChars = systemPrompts.reduce((total, prompt) => total + prompt.length, 0);
  return {
    messageHistoryChars,
    currentTurnChars,
    totalPromptChars: messageHistoryChars + currentTurnChars + systemPromptChars,
  };
}

function messageCharacterCount(message: GhostbuildMessage): number {
  const textSize = message.parts.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 0), 0);
  const nonTextSize = message.parts.reduce(
    (total, part) => total + (part.type === 'text' ? 0 : partCharacterCount(part)),
    0,
  );
  return textSize + nonTextSize;
}

function partCharacterCount(part: GhostbuildPart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text.length;
    case 'file':
      return part.url.length + part.mediaType.length;
    case 'source-url':
      return (part.title ?? '').length + part.url.length;
    case 'source-document':
      return part.title.length + part.mediaType.length;
    case 'step-start':
      return 0;
    default: {
      const invocation = getToolInvocation(part);
      if (!invocation) {
        return stringifyLength(part);
      }
      const terminalSize =
        invocation.state === 'output-available'
          ? stringifyLength(invocation.output)
          : invocation.state === 'output-error'
            ? invocation.errorText.length
            : invocation.state === 'output-denied'
              ? stringifyLength(invocation.approval.reason)
              : 0;
      return stringifyLength(invocation.input) + terminalSize;
    }
  }
}

function stringifyLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}
