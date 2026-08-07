import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

// Pi-native stream chunk — replaces ai:UIMessageChunk
export type PiStreamChunk =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-start'; id: string; toolName: string }
  | { type: 'tool-delta'; id: string; delta: string }
  | { type: 'tool-end'; id: string }
  | { type: 'finish'; finishReason: 'stop' | 'error' | 'tool-calls' | 'length' }
  | { type: 'error'; errorText: string }
  | { type: 'data-deployment-approval'; data: unknown }
  | { type: 'start' };

export type UIMessageChunk = PiStreamChunk; // compat alias until full removal

export function appendDeterministicCompletion(
  stream: ReadableStream<PiStreamChunk>,
  completion: () => string | undefined,
): ReadableStream<PiStreamChunk> {
  let finishChunk: PiStreamChunk | undefined;
  return stream.pipeThrough(
    new TransformStream<PiStreamChunk, PiStreamChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'finish') {
          finishChunk = chunk;
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        const text = completion();
        if (text) {
          const id = 'validated-build-completion';
          controller.enqueue({ type: 'text-start', id });
          controller.enqueue({ type: 'text-delta', id, delta: text });
          controller.enqueue({ type: 'text-end', id });
        }
        if (finishChunk) {
          const terminalFinish = { ...finishChunk, finishReason: 'stop' } as PiStreamChunk;
          controller.enqueue(text ? terminalFinish : finishChunk);
        }
      },
    }),
  );
}

export function normalizeTextPartBoundaries(stream: ReadableStream<PiStreamChunk>): ReadableStream<PiStreamChunk> {
  const openTextPartIds = new Set<string>();
  return stream.pipeThrough(
    new TransformStream<PiStreamChunk, PiStreamChunk>({
      transform(chunk, controller) {
        switch (chunk.type) {
          case 'text-start':
            openTextPartIds.add(chunk.id);
            controller.enqueue(chunk);
            return;
          case 'text-delta':
            if (!openTextPartIds.has(chunk.id)) {
              openTextPartIds.add(chunk.id);
              controller.enqueue({ type: 'text-start', id: chunk.id } as PiStreamChunk);
            }
            controller.enqueue(chunk);
            return;
          case 'text-end':
            if (!openTextPartIds.has(chunk.id)) {
              controller.enqueue({ type: 'text-start', id: chunk.id } as PiStreamChunk);
            }
            controller.enqueue(chunk);
            openTextPartIds.delete(chunk.id);
            return;
          default:
            controller.enqueue(chunk);
        }
      },
    }),
  );
}

// Convert PiStreamChunk readable to newline-delimited JSON for Response body — replaces createUIMessageStreamResponse
export function createPiStreamResponse(stream: ReadableStream<PiStreamChunk>): Response {
  const encoded = stream.pipeThrough(
    new TransformStream<PiStreamChunk, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(chunk) + '\n'));
      },
    }),
  );
  return new Response(encoded, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// Also produce a GhostbuildMessage stream for BuilderAgent's internal transcript sync
export function piChunksToGhostbuildMessages(chunks: PiStreamChunk[]): GhostbuildMessage[] {
  // handled by agents layer; placeholder for type compat
  return [];
}
