import { convertToModelMessages, type ModelMessage, type ToolSet, type UIMessage } from 'ai';
import {
  getToolInvocation,
  messageText,
  type GhostbuildMessage,
  type GhostbuildPart,
} from 'ghostbuild-agent/ai-compat';
import { EXCLUDED_FILE_PATHS } from 'ghostbuild-agent/constants';

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
        content: cleanMessage(messageText(message)),
        parts: message.parts.flatMap((part): GhostbuildPart[] => {
          if (part.type === 'text') {
            return [{ ...part, text: cleanMessage(part.text) }];
          }
          if (part.type !== 'tool-invocation') {
            return [part];
          }

          const invocation = getToolInvocation(part);
          return invocation?.state === 'result' ? [{ type: 'text', text: summarizeToolInvocation(invocation) }] : [];
        }),
      };
    })
    .filter(
      (message) =>
        messageText(message).trim() !== '' ||
        message.parts.some((part) => part.type === 'text' || getToolInvocation(part) !== null),
    );

  const modelMessages = await convertToModelMessages(processedMessages as Array<Omit<UIMessage, 'id'>>, {
    tools: tools ? asAiSdkTools(tools) : undefined,
    ignoreIncompleteToolCalls: true,
  });

  return modelMessages.filter((message) => JSON.stringify(message.content).length > 0);
}

function cleanMessage(message: string) {
  let cleaned = message.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '').replace(/<think>.*?<\/think>/s, '');

  for (const excludedPath of EXCLUDED_FILE_PATHS) {
    const escapedPath = excludedPath.replace(/\//g, '\\/');
    cleaned = cleaned.replace(
      new RegExp(`<boltAction type="file" filePath="${escapedPath}"[^>]*>[\\s\\S]*?<\\/boltAction>`, 'g'),
      `You tried to modify \`${excludedPath}\` but this is not allowed. Please modify a different file.`,
    );
  }

  return cleaned;
}

function summarizeToolInvocation(invocation: NonNullable<ReturnType<typeof getToolInvocation>>) {
  const result = typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result);
  const status = result?.startsWith('Error:') ? 'failed' : 'completed';
  return `The assistant called ${invocation.toolName} with ${JSON.stringify(invocation.args)} and it ${status}.`;
}
