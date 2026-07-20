import { convertToModelMessages, type ModelMessage, type ToolSet, type UIMessage } from 'ai';
import { isGhostbuildToolResult, toolResultSucceeded } from 'ghostbuild-agent/tool-result';
import {
  getToolInvocation,
  messageText,
  type GhostbuildMessage,
  type GhostbuildPart,
} from 'ghostbuild-agent/ai-compat';
import { EXCLUDED_FILE_PATHS } from 'ghostbuild-agent/constants';

const TOOL_RESULT_EXCERPT_CHARS = 6_000;
const TOOL_RESULT_HEAD_CHARS = 1_200;
const TOOL_ARGS_EXCERPT_CHARS = 1_200;

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
          return invocation?.state === 'result'
            ? [{ type: 'text', text: summarizeToolInvocationForPrompt(invocation) }]
            : [];
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

export function summarizeToolInvocationForPrompt(invocation: NonNullable<ReturnType<typeof getToolInvocation>>) {
  const result =
    typeof invocation.result === 'string'
      ? invocation.result
      : (JSON.stringify(invocation.result) ?? String(invocation.result));
  const status = toolResultSucceeded(invocation.result) ? 'completed' : 'failed';
  const argsSummary = summarizeToolArgs(invocation.toolName, invocation.args);
  const structured = isGhostbuildToolResult(invocation.result);
  const resultExcerpt = structured
    ? result
    : excerptLegacyToolResult(result, TOOL_RESULT_EXCERPT_CHARS, TOOL_RESULT_HEAD_CHARS);
  return [
    `The assistant called ${invocation.toolName} with ${argsSummary} and it ${status}.`,
    resultExcerpt ? `${structured ? 'Result' : 'Legacy result excerpt'}:\n${resultExcerpt}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function summarizeToolArgs(toolName: string, args: unknown) {
  if (!args || typeof args !== 'object') {
    return excerptText(JSON.stringify(args), TOOL_ARGS_EXCERPT_CHARS);
  }

  const record = args as Record<string, unknown>;
  switch (toolName) {
    case 'writeFile': {
      const content = typeof record.content === 'string' ? record.content : '';
      return JSON.stringify({
        path: typeof record.path === 'string' ? record.path : undefined,
        contentLength: content.length,
      });
    }
    case 'edit': {
      const edits = Array.isArray(record.edits) ? record.edits : [];
      return JSON.stringify({
        path: typeof record.path === 'string' ? record.path : undefined,
        replacements: edits.length || (typeof record.old === 'string' && typeof record.new === 'string' ? 1 : 0),
      });
    }
    case 'view':
      return JSON.stringify({
        path: typeof record.path === 'string' ? record.path : undefined,
        viewRange: record.view_range,
        cursor: record.cursor,
      });
    case 'deploy':
      return JSON.stringify({ validatedRevision: record.validatedRevision });
    case 'npmInstall':
      return JSON.stringify({ packageSpecs: record.packageSpecs ?? record.packages });
    case 'lookupDocs':
      return JSON.stringify({
        docs: record.components ?? record.keys ?? record.docs,
        section: record.section,
        query: record.query,
        cursor: record.cursor,
      });
    default:
      return excerptText(JSON.stringify(args), TOOL_ARGS_EXCERPT_CHARS);
  }
}

function excerptLegacyToolResult(value: string, maxChars: number, headChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return [
    'Legacy tool result exceeded the current bounded-result contract.',
    excerptText(value, maxChars, headChars),
  ].join('\n');
}

function excerptText(value: string | undefined, maxChars: number, headChars = Math.floor(maxChars / 3)) {
  if (!value) {
    return '';
  }

  if (value.length <= maxChars) {
    return value;
  }

  const boundedHeadChars = Math.min(Math.max(headChars, 0), maxChars);
  const tailChars = maxChars - boundedHeadChars;
  return [
    value.slice(0, boundedHeadChars).trimEnd(),
    `[... truncated ${value.length - maxChars} characters ...]`,
    value.slice(value.length - tailChars).trimStart(),
  ].join('\n');
}
