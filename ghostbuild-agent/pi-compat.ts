import type { Message, Usage, AssistantMessage, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai';
import type { GhostbuildMessage, GhostbuildPart } from './ai-compat.js';
import { messageText } from './ai-compat.js';

// Pi-canonical equivalents for GhostbuildMessage helpers, mirroring workshop-backend's
// StoredAssistantMessage / zeroUsage patterns. Frontend can migrate from ai-compat to
// pi-compat incrementally; backend already uses pi Message via pi-message-conversion.ts.

export type PiGhostbuildMessage = Message;

export function ghostbuildMessageToPiText(message: GhostbuildMessage): string {
  return messageText(message);
}

export function piMessageText(message: Message): string {
  if (message.role === 'user' && typeof message.content === 'string') {
    return message.content;
  }
  if ('content' in message && Array.isArray((message as AssistantMessage).content)) {
    return ((message as AssistantMessage).content as Array<TextContent | ThinkingContent | ToolCall>)
      .filter((b) => b.type === 'text')
      .map((b) => (b as TextContent).text)
      .join('');
  }
  if (typeof (message as { content?: unknown }).content === 'string') {
    return (message as { content: string }).content;
  }
  return '';
}

export type StoredAssistantMessage = Omit<AssistantMessage, 'content'> & {
  content: Array<TextContent | ThinkingContent | Omit<ToolCall, 'arguments'>>;
};

export function makeStoredAssistantMessage(message: AssistantMessage): StoredAssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'toolCall') {
        return block;
      }
      const { arguments: _args, ...rest } = block as ToolCall;
      return rest as Omit<ToolCall, 'arguments'>;
    }),
  } as StoredAssistantMessage;
}

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function isPiToolPart(part: GhostbuildPart): boolean {
  return part.type?.startsWith('tool-') ?? false;
}
