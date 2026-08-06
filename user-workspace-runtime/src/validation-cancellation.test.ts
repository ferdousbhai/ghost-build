import { describe, expect, it, vi } from 'vitest';
import { ProjectValidationCancelledError, ValidationCancellation } from './validation-cancellation';

function processHarness() {
  return {
    waitForExit: vi.fn(async () => ({ exitCode: 0 })),
    kill: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => 'killed' as const),
    getLogs: vi.fn(async () => ({ stdout: '', stderr: '' })),
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

    expect(validationProcess.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills only the attached validation process', async () => {
    const cancellation = new ValidationCancellation();
    const validationProcess = processHarness();
    const unrelatedProcess = processHarness();
    await cancellation.attachProcess(validationProcess);

    await cancellation.cancel();

    expect(validationProcess.kill).toHaveBeenCalledWith('SIGKILL');
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
