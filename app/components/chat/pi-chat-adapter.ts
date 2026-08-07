import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { GhostbuildMessage, GhostbuildPart } from 'ghostbuild-agent/ai-compat';

// Pi-native frontend stream adapter — replaces ai's useChat/toUIMessageStream.
// Backend now emits UIMessageChunk-shaped deltas via piAgentRunner's shim; this module translates
// Pi AgentEvent (the canonical workshop-backend protocol) to GhostbuildPart deltas for the UI.
// Mirrors workshop-backend's AgentEvent -> AiChatStreamEvent shape.

export type PiChatDelta =
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'tool-start'; toolCallId: string; toolName: string }
  | { type: 'tool-delta'; toolCallId: string; delta: string }
  | { type: 'tool-end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'finish'; finishReason: string };

export function agentEventToDeltas(event: AgentEvent): PiChatDelta[] {
  switch (event.type) {
    case 'message_update': {
      const piEvent = event.assistantMessageEvent as unknown as { type: string; delta?: string; contentIndex?: number };
      if (piEvent.type === 'text_delta' && piEvent.delta) {
        return [{ type: 'text-delta', id: `pi-${event.message.timestamp ?? Date.now()}`, delta: piEvent.delta }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [{ type: 'tool-start', toolCallId: event.toolCallId, toolName: event.toolName }];
    case 'tool_execution_end':
      return [{ type: 'tool-end', toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError }];
    default:
      return [];
  }
}

export function deltasToGhostbuildParts(deltas: PiChatDelta[]): GhostbuildPart[] {
  return deltas.map((d) => {
    if (d.type === 'text-delta') return { type: 'text', text: d.delta };
    if (d.type === 'tool-start' || d.type === 'tool-delta' || d.type === 'tool-end') {
      return {
        type: `tool-${d.toolName}` as GhostbuildPart['type'],
        toolCallId: d.toolCallId,
        toolName: d.toolName,
        state: d.type === 'tool-end' ? (d.isError ? 'output-error' : 'output-available') : 'input-available',
        output: (d as { result?: unknown }).result,
      } as GhostbuildPart;
    }
    return { type: 'text', text: '' };
  });
}

// Re-exports for useBuilderAgentChat — allows incremental migration from useAgentChat<UIMessage>
// to pi-native events without touching every callsite at once.
export type PiChatMessage = GhostbuildMessage;
