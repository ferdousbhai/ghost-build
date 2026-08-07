import type { Message, TextContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ModelMessage } from './message-conversion';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

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
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
        } as unknown as Message;
      }
      if (Array.isArray(content)) {
        const blocks = (content as unknown[]).map((part) => {
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text } as TextContent;
          if (p.type === 'tool-call') {
            return {
              type: 'toolCall',
              id: (p.toolCallId ?? p.id ?? `call_${Math.random().toString(36).slice(2)}`) as string,
              name: (p.toolName ?? p.name ?? 'unknown') as string,
              arguments: (p.args ?? p.input ?? {}) as Record<string, unknown>,
            } as ToolCall;
          }
          if (typeof p.text === 'string') return { type: 'text', text: p.text } as TextContent;
          return { type: 'text', text: JSON.stringify(p) } as TextContent;
        });
        return {
          role: 'assistant',
          content: blocks,
          timestamp: Date.now(),
          api: 'openai-completions',
          provider: 'cloudflare-workers-ai',
          model: 'pi-bridge',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
        } as unknown as Message;
      }
    }

    if (role === 'tool') {
      const toolResults = Array.isArray(content) ? content : [content];
      const first = toolResults[0] as Record<string, unknown> | undefined;
      // AI SDK tool content: [{ type: 'tool-result', toolCallId, toolName, result/output }]
      if (first && first.type === 'tool-result') {
        const r = first as unknown as { toolCallId: string; toolName?: string; result?: unknown; output?: unknown };
        return {
          role: 'toolResult',
          toolCallId: r.toolCallId,
          toolName: r.toolName ?? 'unknown',
          content: [{ type: 'text', text: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? r.output ?? '') }],
          isError: false,
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
        .map((c) => (typeof (c as Record<string, unknown>).text === 'string' ? (c as Record<string, unknown>).text as string : JSON.stringify(c)))
        .join('');
      return { role: role as Message['role'], content: text, timestamp: Date.now() } as Message;
    }
    return { role: role as Message['role'], content: String(content ?? ''), timestamp: Date.now() } as Message;
  });
}

// GhostbuildMessage (UIMessage parts) -> pi Message for cases without ModelMessage pruning.
// Used only for deterministic completion shortcut path.
export function ghostbuildMessagesToPi(messages: GhostbuildMessage[]): Message[] {
  return messages.map((m) => {
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('');
    const toolParts = m.parts.filter((p) => (p as { type: string }).type?.startsWith('tool-'));
    if (m.role === 'assistant' && toolParts.length > 0) {
      return {
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
        api: 'openai-completions',
        provider: 'cloudflare-workers-ai',
        model: 'pi-bridge',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
      } as unknown as Message;
    }
    return { role: m.role as Message['role'], content: text, timestamp: Date.now() } as Message;
  });
}
