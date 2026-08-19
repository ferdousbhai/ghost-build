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

export function normalizeTextPartBoundaries(stream: ReadableStream<PiStreamChunk>): ReadableStream<PiStreamChunk> {
  const openTextPartIds = new Set<string>();
  const closeOpenTextParts = (controller: TransformStreamDefaultController<PiStreamChunk>) => {
    for (const id of openTextPartIds) {
      controller.enqueue({ type: 'text-end', id });
    }
    openTextPartIds.clear();
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
          default:
            if (chunk.type === 'finish' || chunk.type === 'error') {
              closeOpenTextParts(controller);
            }
            controller.enqueue(chunk);
        }
      },
      flush(controller) {
        closeOpenTextParts(controller);
      },
    }),
  );
}
