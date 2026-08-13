import { describe, expect, it } from 'vitest';
import { settleCancelledWorkspaceCommand } from './command-cancellation';
import { WorkspaceCommandTerminationIndeterminateError } from './command-termination';

describe('cancelled workspace command settlement', () => {
  it('accepts rejection of the original settlement after exact termination was confirmed', async () => {
    await expect(
      settleCancelledWorkspaceCommand({
        termination: Promise.resolve(),
        settlement: Promise.reject(new Error('original command result rejected after SIGKILL')),
      }),
    ).resolves.toBeUndefined();
  });

  it('preserves termination and recovered-observation failures as indeterminate', async () => {
    const terminationFailure = new WorkspaceCommandTerminationIndeterminateError(new Error('observer unavailable'));
    await expect(
      settleCancelledWorkspaceCommand({
        termination: Promise.reject(terminationFailure),
        settlement: Promise.reject(new Error('original')),
      }),
    ).rejects.toBe(terminationFailure);

    const recoveredFailure = new WorkspaceCommandTerminationIndeterminateError(
      new Error('recovered observer unavailable'),
    );
    await expect(settleCancelledWorkspaceCommand({ settlement: Promise.reject(recoveredFailure) })).rejects.toBe(
      recoveredFailure,
    );
  });
});
