import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ITerminal } from '~/types/terminal';
import { MAX_RETAINED_PROCESS_OUTPUT_CHARS, PROCESS_OUTPUT_TRUNCATION_MARKER } from './process';
import { spawnInteractiveJsh, wireInteractiveTerminal } from './interactive-terminal';
import { newGhostbuildShellProcess } from './ghostbuild-shell';

vi.mock('./interactive-terminal', () => ({
  spawnInteractiveJsh: vi.fn(),
  wireInteractiveTerminal: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('GhostbuildShell', () => {
  test('interrupts and rejects commands that exceed their deadline', async () => {
    vi.useFakeTimers();
    const harness = await initializedShell();
    const command = harness.shell.executeCommand('pnpm run build', { timeoutMs: 25 });
    const rejection = expect(command).rejects.toThrow('Timed out waiting for shell exit');
    await vi.advanceTimersByTimeAsync(26);
    await rejection;
    expect(harness.writes.filter((value) => value === '\x03')).toHaveLength(2);
  });

  test('bounds output retained by an interactive build waiter', async () => {
    const harness = await initializedShell((value, controller) => {
      if (value === 'pnpm run build\n') {
        for (let index = 0; index < 5; index += 1) {
          controller.enqueue(String(index).repeat(300_000));
        }
        controller.enqueue('\x1b]654;exit=0:0\x07');
      }
    });
    const result = await harness.shell.executeCommand('pnpm run build');
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(MAX_RETAINED_PROCESS_OUTPUT_CHARS);
    expect(result.output).toContain(PROCESS_OUTPUT_TRUNCATION_MARKER.trim());
    expect(result.output).toContain('4'.repeat(100));
  });
});

async function initializedShell(
  onWrite: (value: string, controller: ReadableStreamDefaultController<string>) => void = () => undefined,
) {
  let outputController!: ReadableStreamDefaultController<string>;
  const output = new ReadableStream<string>({
    start(controller) {
      outputController = controller;
    },
  });
  const writes: string[] = [];
  const input = new WritableStream<string>({
    write(value) {
      writes.push(value);
      if (value === '\x03') {
        outputController.enqueue('\x1b]654;prompt\x07');
      }
      onWrite(value, outputController);
    },
  }).getWriter();
  vi.mocked(spawnInteractiveJsh).mockResolvedValue({
    process: { kill: vi.fn() } as unknown as WebContainerProcess,
    input,
    output,
  });
  vi.mocked(wireInteractiveTerminal).mockResolvedValue(undefined);
  const shell = newGhostbuildShellProcess();
  const init = shell.init(
    {} as WebContainer,
    {
      cols: 80,
      rows: 24,
      write: vi.fn(),
      onData: vi.fn(),
    } as unknown as ITerminal,
  );
  await Promise.resolve();
  outputController.enqueue('\x1b]654;interactive\x07');
  await init;
  return { shell, writes };
}
