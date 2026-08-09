import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

export type ModelMessage = { role: string; content: unknown };

/** Convert the authoritative UI transcript into the text/tool protocol consumed by Pi. */
export function cleanupAssistantMessages(messages: GhostbuildMessage[]): ModelMessage[] {
  return messages.flatMap(toModelMessages);
}

function toModelMessages(message: GhostbuildMessage): ModelMessage[] {
  if (message.role !== 'assistant') {
    const text = message.parts.map(partText).join('');
    return text || message.role === 'user' ? [{ role: message.role, content: text }] : [];
  }

  const result: ModelMessage[] = [];
  let pendingText = '';
  const flushText = () => {
    const text = pendingText.trim();
    pendingText = '';
    return text ? [{ type: 'text', text }] : [];
  };

  for (const part of message.parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      pendingText += stripHiddenReasoning(part.text);
      continue;
    }
    const invocation = getToolInvocation(part);
    if (!invocation || !isTerminalToolState(invocation.state) || !invocation.toolCallId || !invocation.toolName) {
      continue;
    }
    result.push({
      role: 'assistant',
      content: [
        ...flushText(),
        {
          type: 'tool-call',
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          input: invocation.input ?? {},
        },
      ],
    });
    result.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          output:
            invocation.state === 'output-available'
              ? { type: 'json', value: invocation.output }
              : { type: 'error-text', value: invocation.errorText ?? 'Tool execution failed.' },
        },
      ],
    });
  }

  const finalText = flushText();
  if (finalText.length > 0) {
    result.push({ role: 'assistant', content: finalText });
  }
  return result;
}

function partText(part: GhostbuildMessage['parts'][number]): string {
  return part.type === 'text' && typeof part.text === 'string' ? stripHiddenReasoning(part.text) : '';
}

function isTerminalToolState(state: string): boolean {
  return state === 'output-available' || state === 'output-error' || state === 'output-denied';
}

function stripHiddenReasoning(message: string): string {
  return message
    .replace(/<div\s+class=["']__ghostbuildThought__["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, '');
}
