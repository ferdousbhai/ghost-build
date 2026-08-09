// Pi-native stream chunk — replaces ai:UIMessageChunk
export type PiStreamChunk =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string; dynamic?: boolean }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown; dynamic?: boolean }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown; dynamic?: boolean }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string; dynamic?: boolean }
  | {
      type: 'data-tool-progress';
      id: string;
      data: { toolCallId: string; toolName: string; result: unknown };
      transient: true;
    }
  | { type: 'finish'; finishReason: 'stop' | 'error' | 'tool-calls' | 'length' }
  | { type: 'error'; errorText: string }
  | { type: 'data-deployment-approval'; data: unknown }
  | { type: 'start' };

// Keep the established AI SDK UI stream wire protocol while the model/tool loop runs on Pi.
export function createPiStreamResponse(stream: ReadableStream<PiStreamChunk>): Response {
  return createUIMessageStreamResponse({
    stream: stream as ReadableStream<UIMessageChunk>,
  });
}
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
