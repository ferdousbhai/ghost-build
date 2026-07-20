import type { WebContainerProcess } from '@webcontainer/api';
import { describe, expect, it, vi } from 'vitest';
import { MAX_RETAINED_PROCESS_OUTPUT_CHARS, PROCESS_OUTPUT_TRUNCATION_MARKER, streamOutput } from './process';

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

  it('retains and forwards only a bounded tail of high-volume output', async () => {
    const onOutput = vi.fn();
    const chunks = Array.from({ length: 5 }, (_, index) => String(index).repeat(300_000));
    const result = await streamOutput(processWithOutput(chunks), { onOutput });

    expect(result.output.length).toBe(MAX_RETAINED_PROCESS_OUTPUT_CHARS);
    expect(result.output.startsWith(PROCESS_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(result.output.endsWith('4'.repeat(300_000))).toBe(true);
    expect(onOutput.mock.calls.every(([output]) => output.length <= MAX_RETAINED_PROCESS_OUTPUT_CHARS)).toBe(true);
  });
});
