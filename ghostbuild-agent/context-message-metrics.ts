import { getToolInvocation, type GhostbuildMessage, type GhostbuildPart } from './ai-compat.js';

export type PromptCharacterCounts = {
  messageHistoryChars: number;
  currentTurnChars: number;
  totalPromptChars: number;
};

export function calculatePromptCharacterCounts(
  messages: GhostbuildMessage[],
  systemPrompt = '',
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

  return {
    messageHistoryChars,
    currentTurnChars,
    totalPromptChars: messageHistoryChars + currentTurnChars + systemPrompt.length,
  };
}

function messageCharacterCount(message: GhostbuildMessage): number {
  const textSize = message.parts.reduce(
    (total, part) => total + (part.type === 'text' && typeof part.text === 'string' ? part.text.length : 0),
    0,
  );
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
      return stringLength(part.text);
    case 'file':
      return stringLength(part.url) + stringLength(part.mediaType);
    case 'source-url':
      return stringLength(part.title) + stringLength(part.url);
    case 'source-document':
      return stringLength(part.title) + stringLength(part.mediaType);
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
            ? stringLength(invocation.errorText)
            : invocation.state === 'output-denied'
              ? stringifyLength(invocation.approval?.reason)
              : 0;
      return stringifyLength(invocation.input) + terminalSize;
    }
  }
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function stringifyLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}
