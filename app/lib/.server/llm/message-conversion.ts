import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

export type ModelMessage = { role: string; content: unknown };

export function asOriginalMessages(messages: GhostbuildMessage[]): GhostbuildMessage[] {
  return messages;
}

export async function cleanupAssistantMessages(
  messages: GhostbuildMessage[],
  _tools?: object,
): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') {
      // For non-assistant, produce simple user/assistant message with cleaned text
      const cleanedParts = msg.parts.map((p) =>
        p.type === 'text' && typeof (p as { text: string }).text === 'string'
          ? { ...p, text: cleanMessage((p as { text: string }).text) }
          : p,
      );
      const text = cleanedParts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      // Also handle tool parts inside non-assistant? Rare, but include
      const toolParts = cleanedParts.filter((p) => p.type !== 'text');
      if (text || msg.role === 'user') {
        if (text) {
          // Preserve as single message with text content for non-assistant roles
          result.push({ role: msg.role, content: text } as ModelMessage);
        }
        // For completeness, emit tool parts as separate messages if needed (not needed for tests)
        for (const part of toolParts) {
          const conv = ghostbuildPartToModelMessages(part as Record<string, unknown>);
          result.push(...conv);
        }
      } else if (toolParts.length > 0) {
        for (const part of toolParts) {
          const conv = ghostbuildPartToModelMessages(part as Record<string, unknown>);
          result.push(...conv);
        }
      }
      continue;
    }

    // Assistant role: may contain text and tool calls/results
    const textParts = msg.parts.filter((p) => p.type === 'text');
    const toolParts = msg.parts.filter((p) => p.type !== 'text');

    // First, handle text parts (if any) — not in current tests but keep
    if (textParts.length > 0) {
      const text = textParts
        .map((p) => cleanMessage((p as { text: string }).text))
        .join('')
        .trim();
      if (text) {
        result.push({ role: 'assistant', content: text } as ModelMessage);
      }
    }

    for (const part of toolParts) {
      const p = part as Record<string, unknown>;
      const toolCallId = (p.toolCallId as string) ?? (p.id as string) ?? `call_${Math.random().toString(36).slice(2)}`;
      // Derive toolName from part.type or toolName field
      let toolName: string;
      if (typeof p.toolName === 'string' && p.toolName) {
        toolName = p.toolName;
      } else if (typeof p.type === 'string' && p.type.startsWith('tool-')) {
        toolName = (p.type as string).slice(5);
      } else {
        toolName = 'unknown';
      }
      const state = p.state as string | undefined;
      const input = (p.input as unknown) ?? {};
      const output = p.output as unknown;
      const errorText = p.errorText as string | undefined;
      const approval = p.approval as { id?: string; approved?: boolean; reason?: string } | undefined;

      // Emit assistant tool-call
      result.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName, input }],
      } as ModelMessage);

      // Emit tool result(s) depending on state
      if (state === 'output-available') {
        result.push({
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'json', value: output } }],
        } as ModelMessage);
      } else if (state === 'output-error') {
        result.push({
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId, toolName, output: { type: 'error-text', value: errorText ?? 'Error' } },
          ],
        } as ModelMessage);
      } else if (state === 'output-denied') {
        const blocks: unknown[] = [];
        if (approval) {
          blocks.push({
            type: 'tool-approval-response',
            approvalId: approval.id,
            approved: false,
            reason: approval.reason ?? errorText,
          });
        }
        blocks.push({
          type: 'tool-result',
          toolCallId,
          toolName,
          output: { type: 'error-text', value: errorText ?? approval?.reason ?? 'Denied' },
        });
        result.push({ role: 'tool', content: blocks } as ModelMessage);
      } else if (state === 'input-available' || state === 'input-streaming' || !state) {
        // No tool result yet — only assistant tool-call (for in-progress). Tests don't cover this alone.
        // Do not emit tool result for in-progress.
      }
    }

    // Filter empty messages like original did: JSON.stringify(message.content).length > 0
  }

  return result.filter((m) => {
    const c = (m as { content?: unknown }).content;
    if (c === undefined || c === null) {
      return false;
    }
    try {
      return JSON.stringify(c).length > 0;
    } catch {
      return true;
    }
  });
}

function ghostbuildPartToModelMessages(p: Record<string, unknown>): ModelMessage[] {
  // Fallback for unexpected tool parts in non-assistant messages — emit as assistant tool-call + tool result if possible
  const toolCallId = (p.toolCallId as string) ?? `call_${Math.random().toString(36).slice(2)}`;
  const toolName =
    (p.toolName as string) ?? (typeof p.type === 'string' ? (p.type as string).replace(/^tool-/, '') : 'unknown');
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input: p.input ?? {} }] } as ModelMessage,
  ];
}

function cleanMessage(message: string) {
  return message.replace(/<div class=\\"__ghostbuildThought__\\">.*?<\/div>/s, '').replace(/<think>.*?<\/think>/s, '');
}
