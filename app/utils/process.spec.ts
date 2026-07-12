import type { WebContainerProcess } from '@webcontainer/api';
import { describe, expect, it, vi } from 'vitest';
import { streamOutput } from './process';

function processWithOutput(chunks: string[], exitCode = 0): WebContainerProcess {
  return {
    exit: Promise.resolve(exitCode),
    output: new ReadableStream<string>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
  } as WebContainerProcess;
}

describe('streamOutput', () => {
  it('waits for process completion even when output begins with an error-like line', async () => {
    const onOutput = vi.fn();

    const result = await streamOutput(processWithOutput(['Error: diagnostic only\n', 'completed\n']), { onOutput });

    expect(result).toEqual({ output: 'Error: diagnostic only\ncompleted\n', exitCode: 0 });
    expect(onOutput).toHaveBeenLastCalledWith(result.output);
  });
});
