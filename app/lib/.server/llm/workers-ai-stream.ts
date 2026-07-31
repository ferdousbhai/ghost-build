import type { UIMessageChunk } from 'ai';

export function appendDeterministicCompletion(
  stream: ReadableStream<UIMessageChunk>,
  completion: () => string | undefined,
): ReadableStream<UIMessageChunk> {
  let finishChunk: UIMessageChunk | undefined;
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
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
          const terminalFinish = { ...finishChunk, finishReason: 'stop' } as UIMessageChunk;
          controller.enqueue(text ? terminalFinish : finishChunk);
        }
      },
    }),
  );
}

export function normalizeTextPartBoundaries(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  const openTextPartIds = new Set<string>();
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        switch (chunk.type) {
          case 'text-start':
            openTextPartIds.add(chunk.id);
            controller.enqueue(chunk);
            return;
          case 'text-delta':
            if (!openTextPartIds.has(chunk.id)) {
              openTextPartIds.add(chunk.id);
              controller.enqueue({ type: 'text-start', id: chunk.id } as UIMessageChunk);
            }
            controller.enqueue(chunk);
            return;
          case 'text-end':
            if (!openTextPartIds.has(chunk.id)) {
              controller.enqueue({ type: 'text-start', id: chunk.id } as UIMessageChunk);
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
