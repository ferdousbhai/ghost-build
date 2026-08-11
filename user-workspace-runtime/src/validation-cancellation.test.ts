import { describe, expect, it, vi } from 'vitest';
import { ProjectValidationCancelledError, ValidationCancellation } from './validation-cancellation';

function processHarness() {
  return {
    id: 'process-1',
    output: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false })),
    waitForExit: vi.fn(async () => ({ code: 137, timedOut: false })),
    kill: vi.fn(async () => undefined),
    status: vi.fn(async () => ({
      id: 'process-1',
      pid: 123,
      command: ['/bin/true'] as const,
      startedAt: '2026-08-11T00:00:00.000Z',
      endedAt: '2026-08-11T00:00:01.000Z',
      state: 'exited' as const,
      exit: { code: 137, timedOut: false },
    })),
  };
}

describe('validation cancellation', () => {
  it('does not kill an unrelated process before this validation owns one', async () => {
    const cancellation = new ValidationCancellation();
    const unrelatedProcess = processHarness();

    await cancellation.cancel();

    expect(unrelatedProcess.kill).not.toHaveBeenCalled();
    expect(() => cancellation.requireActive()).toThrow(ProjectValidationCancelledError);
  });

  it('kills the exact process if cancellation wins the process-start race', async () => {
    const cancellation = new ValidationCancellation();
    const validationProcess = processHarness();
    await cancellation.cancel();

    await expect(cancellation.attachProcess(validationProcess)).rejects.toBeInstanceOf(ProjectValidationCancelledError);

    expect(validationProcess.kill).toHaveBeenCalledWith(9);
  });

  it('kills only the attached validation process', async () => {
    const cancellation = new ValidationCancellation();
    const validationProcess = processHarness();
    const unrelatedProcess = processHarness();
    await cancellation.attachProcess(validationProcess);

    await cancellation.cancel();

    expect(validationProcess.kill).toHaveBeenCalledWith(9);
    expect(unrelatedProcess.kill).not.toHaveBeenCalled();
  });

  it('coalesces concurrent cancellation requests', async () => {
    const cancellation = new ValidationCancellation();
    const validationProcess = processHarness();
    await cancellation.attachProcess(validationProcess);

    await Promise.all([cancellation.cancel(), cancellation.cancel()]);

    expect(validationProcess.kill).toHaveBeenCalledOnce();
  });
});
