import type { UIMessageChunk } from 'ai';

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
