import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { appendDeterministicCompletion } from './workers-ai-stream';

describe('appendDeterministicCompletion', () => {
  it('places server-owned completion copy before a terminal stop chunk', async () => {
    const source = chunks([
      { type: 'start' },
      { type: 'tool-output-available', toolCallId: 'deploy-1', output: { state: 'awaiting-approval' } },
      { type: 'finish', finishReason: 'tool-calls' },
    ] as UIMessageChunk[]);

    const result = await readChunks(
      appendDeterministicCompletion(source, () => 'The production deployment plan is ready for your approval.'),
    );

    expect(result.slice(-4)).toEqual([
      { type: 'text-start', id: 'validated-build-completion' },
      {
        type: 'text-delta',
        id: 'validated-build-completion',
        delta: 'The production deployment plan is ready for your approval.',
      },
      { type: 'text-end', id: 'validated-build-completion' },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('preserves the stream unchanged when there is no deterministic completion', async () => {
    const input = [{ type: 'start' }, { type: 'finish', finishReason: 'stop' }] as UIMessageChunk[];

    await expect(readChunks(appendDeterministicCompletion(chunks(input), () => undefined))).resolves.toEqual(input);
  });
});

function chunks(values: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) {
        controller.enqueue(value);
      }
      controller.close();
    },
  });
}

async function readChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const result: UIMessageChunk[] = [];
  for await (const chunk of stream) {
    result.push(chunk);
  }
  return result;
}
