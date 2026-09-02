import type { PiStreamChunk } from './pi-stream';

export function appendDeterministicCompletion(
  stream: ReadableStream<PiStreamChunk>,
  completion: () => string | undefined,
): ReadableStream<PiStreamChunk> {
  let finishChunk: Extract<PiStreamChunk, { type: 'finish' }> | undefined;
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
          const terminalFinish: PiStreamChunk = { ...finishChunk, finishReason: 'stop' };
          controller.enqueue(text ? terminalFinish : finishChunk);
        }
      },
    }),
  );
}

/**
 * Text and reasoning both arrive as provider-framed parts, and a provider that ends a turn mid-part
 * would otherwise leave the client rendering an assistant bubble that never closes. Every open part
 * is closed before the terminal chunk and again at flush, and a delta that arrives without its start
 * opens the part it belongs to.
 */
export function normalizeTextPartBoundaries(stream: ReadableStream<PiStreamChunk>): ReadableStream<PiStreamChunk> {
  const openTextPartIds = new Set<string>();
  const openReasoningPartIds = new Set<string>();
  const closeOpenParts = (controller: TransformStreamDefaultController<PiStreamChunk>) => {
    for (const id of openTextPartIds) {
      controller.enqueue({ type: 'text-end', id });
    }
    openTextPartIds.clear();
    for (const id of openReasoningPartIds) {
      controller.enqueue({ type: 'reasoning-end', id });
    }
    openReasoningPartIds.clear();
  };
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
              controller.enqueue({ type: 'text-start', id: chunk.id });
            }
            controller.enqueue(chunk);
            return;
          case 'text-end':
            if (!openTextPartIds.has(chunk.id)) {
              controller.enqueue({ type: 'text-start', id: chunk.id });
            }
            controller.enqueue(chunk);
            openTextPartIds.delete(chunk.id);
            return;
          case 'reasoning-start':
            openReasoningPartIds.add(chunk.id);
            controller.enqueue(chunk);
            return;
          case 'reasoning-delta':
            if (!openReasoningPartIds.has(chunk.id)) {
              openReasoningPartIds.add(chunk.id);
              controller.enqueue({ type: 'reasoning-start', id: chunk.id });
            }
            controller.enqueue(chunk);
            return;
          case 'reasoning-end':
            if (!openReasoningPartIds.has(chunk.id)) {
              controller.enqueue({ type: 'reasoning-start', id: chunk.id });
            }
            controller.enqueue(chunk);
            openReasoningPartIds.delete(chunk.id);
            return;
          default:
            if (chunk.type === 'finish' || chunk.type === 'error') {
              closeOpenParts(controller);
            }
            controller.enqueue(chunk);
        }
      },
      flush(controller) {
        closeOpenParts(controller);
      },
    }),
  );
}
