import { convertToModelMessages, type ModelMessage, type ToolSet, type UIMessage } from 'ai';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

export function asAiSdkTools(tools: object): ToolSet {
  return tools as ToolSet;
}

export function asOriginalMessages(messages: GhostbuildMessage[]): UIMessage[] {
  return messages as UIMessage[];
}

export async function cleanupAssistantMessages(messages: GhostbuildMessage[], tools?: object): Promise<ModelMessage[]> {
  const processedMessages = messages
    .map((message) => {
      if (message.role !== 'assistant') {
        return message;
      }

      return {
        ...message,
        parts: message.parts.map((part) => (part.type === 'text' ? { ...part, text: cleanMessage(part.text) } : part)),
      };
    })
    .filter((message) => message.parts.length > 0);

  const modelMessages = await convertToModelMessages(processedMessages as Array<Omit<UIMessage, 'id'>>, {
    tools: tools ? asAiSdkTools(tools) : undefined,
    ignoreIncompleteToolCalls: true,
  });

  return modelMessages.filter((message) => JSON.stringify(message.content).length > 0);
}

function cleanMessage(message: string) {
  return message.replace(/<div class=\\"__ghostbuildThought__\\">.*?<\/div>/s, '').replace(/<think>.*?<\/think>/s, '');
}
