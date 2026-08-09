import type { Message, TextContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ModelMessage } from './message-conversion';

// Converts AI SDK ModelMessage[] (produced by prepareModelInput/pruneMessages) to Pi Message[].
// Structure is intentionally loose — both use OpenAI-compatible shapes. This preserves text +
// tool-call/tool-result semantics while staying true to cloudflare-os pi-ai Message types.

export function modelMessagesToPi(messages: ModelMessage[]): Message[] {
  return messages.map((m) => {
    const role = (m as unknown as { role: string }).role;
    const content = (m as unknown as { content: unknown }).content;

    if (role === 'assistant') {
      // AI SDK assistant content can be string or array with text/tool-call parts
      if (typeof content === 'string') {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: content }],
          timestamp: Date.now(),
          api: 'openai-completions',
          provider: 'cloudflare-workers-ai',
          model: 'pi-bridge',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
        } as unknown as Message;
      }
      if (Array.isArray(content)) {
        const blocks = (content as unknown[]).map((part) => {
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string') {
            return { type: 'text', text: p.text } as TextContent;
          }
          if (p.type === 'tool-call') {
            return {
              type: 'toolCall',
              id: (p.toolCallId ?? p.id ?? `call_${Math.random().toString(36).slice(2)}`) as string,
              name: (p.toolName ?? p.name ?? 'unknown') as string,
              arguments: (p.args ?? p.input ?? {}) as Record<string, unknown>,
            } as ToolCall;
          }
          if (typeof p.text === 'string') {
            return { type: 'text', text: p.text } as TextContent;
          }
          return { type: 'text', text: JSON.stringify(p) } as TextContent;
        });
        return {
          role: 'assistant',
          content: blocks,
          timestamp: Date.now(),
          api: 'openai-completions',
          provider: 'cloudflare-workers-ai',
          model: 'pi-bridge',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
        } as unknown as Message;
      }
    }

    if (role === 'tool') {
      const toolResults = Array.isArray(content) ? content : [content];
      const resultPart = toolResults.find(
        (part) => typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'tool-result',
      ) as Record<string, unknown> | undefined;
      // AI SDK tool content: [{ type: 'tool-result', toolCallId, toolName, result/output }]
      if (resultPart) {
        const r = resultPart as unknown as {
          toolCallId: string;
          toolName?: string;
          result?: unknown;
          output?: unknown;
        };
        const output = r.result ?? unwrapToolOutput(r.output);
        return {
          role: 'toolResult',
          toolCallId: r.toolCallId,
          toolName: r.toolName ?? 'unknown',
          content: [
            {
              type: 'text',
              text: typeof output === 'string' ? output : stringify(output),
            },
          ],
          isError: isErrorToolOutput(r.output),
          timestamp: Date.now(),
        } as unknown as ToolResultMessage;
      }
      return {
        role: 'user',
        content: typeof content === 'string' ? content : JSON.stringify(content),
        timestamp: Date.now(),
      } as Message;
    }

    // user / system
    if (typeof content === 'string') {
      return { role: role as Message['role'], content, timestamp: Date.now() } as Message;
    }
    if (Array.isArray(content)) {
      const text = (content as unknown[])
        .map((c) =>
          typeof (c as Record<string, unknown>).text === 'string'
            ? ((c as Record<string, unknown>).text as string)
            : JSON.stringify(c),
        )
        .join('');
      return { role: role as Message['role'], content: text, timestamp: Date.now() } as Message;
    }
    return { role: role as Message['role'], content: String(content ?? ''), timestamp: Date.now() } as Message;
  });
}

function unwrapToolOutput(output: unknown): unknown {
  return isRecord(output) && 'value' in output ? output.value : output;
}

function isErrorToolOutput(output: unknown): boolean {
  return isRecord(output) && typeof output.type === 'string' && output.type.startsWith('error-');
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value ?? '');
  } catch {
    return String(value ?? '');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
